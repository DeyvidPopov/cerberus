//! Client-side account handshake crypto (ADR-0001, ADR-0007) — pure Rust.
//!
//! These functions produce exactly what the server needs (the auth key, public
//! KDF params, and the AEAD-wrapped vault key) and nothing it must not see. The
//! master password and the encryption key never leave this layer; only the auth
//! key (the login proof) and the opaque wrapped vault key are surfaced for the
//! command layer to send to the server.

use crate::crypto::{
    derive_auth_key, derive_encryption_key, derive_master_key, generate_vault_key,
    unwrap_vault_key, wrap_vault_key, AeadCiphertext, AuthKey, EncryptionKey, KdfParams, MasterKey,
    SecretString, VaultKey, KDF_VERSION,
};
use crate::error::{AppError, AppResult};

/// Length of the per-account KDF salt (ADR-0001).
pub const SALT_LEN: usize = 16;

/// The result of preparing a registration: what to send to the server, plus the
/// vault key the client keeps in memory (it is now unlocked).
pub struct RegistrationMaterial {
    /// Sent to the server (which stores only an Argon2id hash of it).
    pub auth_key: AuthKey,
    pub kdf_version: u32,
    pub kdf_params: KdfParams,
    pub kdf_salt: [u8; SALT_LEN],
    /// The vault key wrapped under the encryption key — opaque to the server.
    pub wrapped_vault_key: AeadCiphertext,
    /// Kept in memory by the client; never sent.
    pub vault_key: VaultKey,
}

/// Build registration material from a master password, using the pinned KDF
/// params (ADR-0001). Generates a fresh random salt and a fresh random vault key.
pub fn build_registration(password: &SecretString) -> AppResult<RegistrationMaterial> {
    build_registration_with_params(password, KdfParams::V1)
}

/// As [`build_registration`] but with explicit KDF params (used by tests to avoid
/// the ~0.5 s production cost).
pub fn build_registration_with_params(
    password: &SecretString,
    params: KdfParams,
) -> AppResult<RegistrationMaterial> {
    let mut salt = [0u8; SALT_LEN];
    getrandom::getrandom(&mut salt).map_err(|_| AppError::Random)?;

    let master = derive_master_key(password, &salt, &params)?;
    let auth_key = derive_auth_key(&master)?;
    let encryption_key = derive_encryption_key(&master)?;
    let vault_key = generate_vault_key()?;
    let wrapped_vault_key = wrap_vault_key(&encryption_key, &vault_key)?;

    Ok(RegistrationMaterial {
        auth_key,
        kdf_version: KDF_VERSION,
        kdf_params: params,
        kdf_salt: salt,
        wrapped_vault_key,
        vault_key,
    })
}

/// Derive the auth key the client sends at login (ADR-0001), using the KDF
/// params returned by prelogin.
pub fn derive_login_auth_key(
    password: &SecretString,
    salt: &[u8],
    params: &KdfParams,
) -> AppResult<AuthKey> {
    let master = derive_master_key(password, salt, params)?;
    derive_auth_key(&master)
}

/// After a successful login, unwrap the server-returned wrapped vault key with the
/// encryption key re-derived from the master password — unlocking the vault. A
/// wrong password yields a different encryption key and fails as a clean
/// decryption error (no panic).
pub fn unwrap_login_vault_key(
    password: &SecretString,
    salt: &[u8],
    params: &KdfParams,
    wrapped: &AeadCiphertext,
) -> AppResult<VaultKey> {
    let master = derive_master_key(password, salt, params)?;
    let encryption_key: EncryptionKey = derive_encryption_key(&master)?;
    unwrap_vault_key(&encryption_key, wrapped)
}

/// Re-derive both account keys from a master password (helper for callers that
/// need the encryption key without unwrapping immediately).
pub fn derive_account_keys(
    password: &SecretString,
    salt: &[u8],
    params: &KdfParams,
) -> AppResult<(AuthKey, EncryptionKey)> {
    let master: MasterKey = derive_master_key(password, salt, params)?;
    Ok((derive_auth_key(&master)?, derive_encryption_key(&master)?))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn cheap() -> KdfParams {
        KdfParams {
            memory_kib: 64,
            iterations: 1,
            parallelism: 1,
        }
    }

    #[test]
    fn login_rederives_the_same_auth_key_as_registration() {
        let pw = SecretString::from("correct horse battery staple");
        let material = build_registration_with_params(&pw, cheap()).unwrap();

        // The server verifies the login auth key against the registered one; the
        // client must re-derive an identical auth key from the same inputs.
        let login_auth =
            derive_login_auth_key(&pw, &material.kdf_salt, &material.kdf_params).unwrap();
        assert!(material.auth_key.ct_eq(&login_auth));
    }

    #[test]
    fn login_unwraps_the_same_vault_key() {
        let pw = SecretString::from("master-pw");
        let material = build_registration_with_params(&pw, cheap()).unwrap();

        // After login the server returns the wrapped vault key; unwrapping it must
        // recover exactly the vault key generated at registration.
        let unwrapped = unwrap_login_vault_key(
            &pw,
            &material.kdf_salt,
            &material.kdf_params,
            &material.wrapped_vault_key,
        )
        .unwrap();
        assert!(material.vault_key.ct_eq(&unwrapped));
    }

    #[test]
    fn wrong_password_yields_a_different_auth_key() {
        let material =
            build_registration_with_params(&SecretString::from("right"), cheap()).unwrap();
        let wrong = derive_login_auth_key(
            &SecretString::from("wrong"),
            &material.kdf_salt,
            &material.kdf_params,
        )
        .unwrap();
        assert!(!material.auth_key.ct_eq(&wrong));
    }

    #[test]
    fn wrong_password_cannot_unwrap_the_vault_key() {
        let material =
            build_registration_with_params(&SecretString::from("right"), cheap()).unwrap();
        let result = unwrap_login_vault_key(
            &SecretString::from("wrong"),
            &material.kdf_salt,
            &material.kdf_params,
            &material.wrapped_vault_key,
        );
        assert!(matches!(result, Err(AppError::Decryption)));
    }

    #[test]
    fn registration_salt_is_the_expected_length() {
        let material = build_registration_with_params(&SecretString::from("pw"), cheap()).unwrap();
        assert_eq!(material.kdf_salt.len(), SALT_LEN);
    }
}
