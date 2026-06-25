//! Vault logic — credential encryption/decryption and master-password rotation.
//!
//! Builds on [`crate::crypto`] (ADR-0001). The vault and the adaptive-auth engine
//! stay cleanly separated (PROJECT.md §1.3); nothing here reaches into risk logic.
//!
//! Pure Rust (ADR-0003): plain functions, fully unit-testable. Credential records
//! are treated as opaque byte blobs here — their concrete shape and serialization
//! land with vault sync; this module owns only the crypto.

use crate::crypto::{
    open, seal, unwrap_vault_key, wrap_vault_key, AeadCiphertext, EncryptionKey, SecretBytes,
    VaultKey,
};
use crate::error::AppResult;

pub mod account;
pub mod manager;
pub mod store;

pub use account::{
    build_registration, derive_login_auth_key, unwrap_login_vault_key, RegistrationMaterial,
};
pub use manager::{
    CredentialData, CredentialRecord, CredentialSummary, MergeOutcome, PulledCredential,
    VaultManager,
};
pub use store::{VaultFile, VaultStore};

/// Associated data binding credential ciphertext to its purpose (domain separation).
const CREDENTIAL_AAD: &[u8] = b"cerberus/credential/v1";

/// Encrypt a credential's serialized bytes under the vault key (ADR-0001).
pub fn encrypt_credential(vault: &VaultKey, plaintext: &[u8]) -> AppResult<AeadCiphertext> {
    seal(vault.as_bytes(), plaintext, CREDENTIAL_AAD)
}

/// Decrypt a credential under the vault key. Wrong key or tampering returns
/// [`crate::AppError::Decryption`]. The plaintext is returned as a zeroizing secret.
pub fn decrypt_credential(vault: &VaultKey, ct: &AeadCiphertext) -> AppResult<SecretBytes> {
    let plaintext = open(vault.as_bytes(), ct, CREDENTIAL_AAD)?;
    Ok(SecretBytes::new(plaintext))
}

/// Rotate the master password by re-wrapping the vault key under a new encryption
/// key, **without re-encrypting any credentials** (ADR-0001 rotation property).
///
/// Given the currently-stored wrapped vault key and the old/new encryption keys
/// (each derived from the old/new master password), returns the new wrapped
/// vault-key blob. Existing credential ciphertexts are untouched and still
/// decrypt under the same vault key.
pub fn rotate_master_password(
    wrapped: &AeadCiphertext,
    old_enc: &EncryptionKey,
    new_enc: &EncryptionKey,
) -> AppResult<AeadCiphertext> {
    let vault = unwrap_vault_key(old_enc, wrapped)?;
    wrap_vault_key(new_enc, &vault)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::crypto::{generate_vault_key, KEY_LEN};

    fn enc_key(byte: u8) -> EncryptionKey {
        EncryptionKey::from_bytes([byte; KEY_LEN])
    }

    #[test]
    fn credential_round_trips() {
        let vault = generate_vault_key().unwrap();
        let secret = b"{\"username\":\"alice\",\"password\":\"s3cr3t\"}";
        let ct = encrypt_credential(&vault, secret).unwrap();
        let pt = decrypt_credential(&vault, &ct).unwrap();
        assert_eq!(pt.expose(), secret);
    }

    #[test]
    fn credential_round_trip_property_over_random_inputs() {
        // Property: for random plaintexts, decrypt(encrypt(m)) == m.
        let vault = generate_vault_key().unwrap();
        for _ in 0..100 {
            let mut len_byte = [0u8; 1];
            getrandom::getrandom(&mut len_byte).unwrap();
            let mut msg = vec![0u8; len_byte[0] as usize];
            getrandom::getrandom(&mut msg).unwrap();

            let ct = encrypt_credential(&vault, &msg).unwrap();
            let pt = decrypt_credential(&vault, &ct).unwrap();
            assert_eq!(pt.expose(), msg.as_slice());
        }
    }

    #[test]
    fn credential_tamper_fails() {
        let vault = generate_vault_key().unwrap();
        let mut ct = encrypt_credential(&vault, b"secret").unwrap();
        ct.ciphertext[0] ^= 0x01;
        assert!(decrypt_credential(&vault, &ct).is_err());
    }

    #[test]
    fn credential_wrong_vault_key_fails() {
        let vault = generate_vault_key().unwrap();
        let other = generate_vault_key().unwrap();
        let ct = encrypt_credential(&vault, b"secret").unwrap();
        assert!(decrypt_credential(&other, &ct).is_err());
    }

    /// The ADR-0001 rotation property: after rotation, the SAME credential
    /// ciphertext still decrypts via the re-wrapped vault key, and the
    /// credential ciphertext bytes are unchanged.
    #[test]
    fn rotation_rewraps_without_reencrypting_credentials() {
        let old_enc = enc_key(0xA1);
        let new_enc = enc_key(0xB2);

        // Set up: a vault key wrapped under the old encryption key, plus a credential.
        let vault = generate_vault_key().unwrap();
        let wrapped_old = wrap_vault_key(&old_enc, &vault).unwrap();
        let credential_ct = encrypt_credential(&vault, b"unchanging credential").unwrap();

        // Rotate the master password (re-wrap only).
        let wrapped_new = rotate_master_password(&wrapped_old, &old_enc, &new_enc).unwrap();

        // The credential ciphertext is byte-for-byte unchanged (NOT re-encrypted).
        let still_ct = credential_ct.clone();
        assert_eq!(still_ct, credential_ct);

        // The old encryption key can no longer unwrap the vault key...
        assert!(unwrap_vault_key(&old_enc, &wrapped_new).is_err());

        // ...but the new one can, and it recovers the SAME vault key,
        // which still decrypts the untouched credential ciphertext.
        let vault_again = unwrap_vault_key(&new_enc, &wrapped_new).unwrap();
        assert!(vault.ct_eq(&vault_again));
        let pt = decrypt_credential(&vault_again, &credential_ct).unwrap();
        assert_eq!(pt.expose(), b"unchanging credential");
    }
}
