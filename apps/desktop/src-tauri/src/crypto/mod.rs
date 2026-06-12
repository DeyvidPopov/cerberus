//! Cryptographic core — KDF, AEAD, key hierarchy, zeroizing secret types.
//!
//! Implements the model in PROJECT.md §3 and ADR-0001:
//!
//! ```text
//! master password ─Argon2id─► master key ─HKDF─┬─► auth key (server proof)
//!                                              └─► encryption key ─wraps─► vault key
//!                                                                  vault key ─AEAD─► credential
//! ```
//!
//! Pure Rust (no Tauri runtime, ADR-0003): everything here is ordinary `pub`
//! functions/types, unit-testable with `cargo test`. The `#[tauri::command]`
//! wrappers are added in a later milestone.

use zeroize::Zeroize;

use crate::error::{AppError, AppResult};

pub mod aead;
pub mod kdf;
pub mod secret;

pub use aead::{open, seal, AeadCiphertext, NONCE_LEN};
pub use kdf::{derive_auth_key, derive_encryption_key, derive_master_key, KdfParams, KDF_VERSION};
pub use secret::{AuthKey, EncryptionKey, MasterKey, SecretBytes, SecretString, VaultKey, KEY_LEN};

/// Associated data binding a wrapped-vault-key blob to its purpose (domain
/// separation): it can only be opened in the vault-key-unwrap context.
const VAULT_KEY_AAD: &[u8] = b"cerberus/vault-key-wrap/v1";

/// Generate a fresh random per-user vault key (ADR-0001).
pub fn generate_vault_key() -> AppResult<VaultKey> {
    let mut bytes = [0u8; KEY_LEN];
    getrandom::getrandom(&mut bytes).map_err(|_| AppError::Random)?;
    let key = VaultKey::from_bytes(bytes);
    bytes.zeroize();
    Ok(key)
}

/// Wrap (AEAD-encrypt) the vault key under the encryption key for storage at rest.
pub fn wrap_vault_key(enc: &EncryptionKey, vault: &VaultKey) -> AppResult<AeadCiphertext> {
    seal(enc.as_bytes(), vault.as_bytes(), VAULT_KEY_AAD)
}

/// Unwrap the vault key. Wrong encryption key or a tampered blob returns
/// [`AppError::Decryption`] — never wrong key bytes, never a panic.
pub fn unwrap_vault_key(enc: &EncryptionKey, wrapped: &AeadCiphertext) -> AppResult<VaultKey> {
    let mut bytes = open(enc.as_bytes(), wrapped, VAULT_KEY_AAD)?;
    let key = VaultKey::from_slice(&bytes);
    bytes.zeroize(); // wipe the transient plaintext key material
    key
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn enc_key(byte: u8) -> EncryptionKey {
        EncryptionKey::from_bytes([byte; KEY_LEN])
    }

    #[test]
    fn generated_vault_keys_are_random() {
        let a = generate_vault_key().unwrap();
        let b = generate_vault_key().unwrap();
        assert!(!a.ct_eq(&b));
    }

    #[test]
    fn wrap_then_unwrap_round_trips() {
        let enc = enc_key(0x11);
        let vault = generate_vault_key().unwrap();
        let wrapped = wrap_vault_key(&enc, &vault).unwrap();
        let unwrapped = unwrap_vault_key(&enc, &wrapped).unwrap();
        assert!(vault.ct_eq(&unwrapped));
    }

    #[test]
    fn wrap_unwrap_property_over_random_vault_keys() {
        // Property: for random vault keys, unwrap(wrap(k)) recovers k exactly.
        let enc = enc_key(0x33);
        for _ in 0..100 {
            let vault = generate_vault_key().unwrap();
            let wrapped = wrap_vault_key(&enc, &vault).unwrap();
            let got = unwrap_vault_key(&enc, &wrapped).unwrap();
            assert!(vault.ct_eq(&got));
        }
    }

    #[test]
    fn unwrap_with_wrong_key_fails_cleanly() {
        let vault = generate_vault_key().unwrap();
        let wrapped = wrap_vault_key(&enc_key(0x11), &vault).unwrap();
        let result = unwrap_vault_key(&enc_key(0x22), &wrapped);
        assert!(matches!(result, Err(AppError::Decryption)));
    }

    #[test]
    fn tampered_wrapped_key_fails_authentication() {
        let enc = enc_key(0x11);
        let mut wrapped = wrap_vault_key(&enc, &generate_vault_key().unwrap()).unwrap();
        wrapped.ciphertext[0] ^= 0x01;
        assert!(matches!(
            unwrap_vault_key(&enc, &wrapped),
            Err(AppError::Decryption)
        ));
    }
}
