//! Application error type (PROJECT.md §4.1).
//!
//! One error enum via `thiserror`. Error messages surfaced to the UI must never
//! leak secret material or internal crypto detail. Concrete variants are added
//! as the crypto and vault layers land in later phases.

use thiserror::Error;

/// The single error type returned across the Tauri command boundary.
///
/// Every fallible path in the crate returns [`AppResult`]; panics must never
/// cross the FFI boundary (PROJECT.md §4.1).
///
/// Variant messages are intentionally generic — they never include secret
/// material, plaintext, keys, or fine-grained crypto detail (PROJECT.md §1, §5).
/// In particular, a wrong key and a tampered ciphertext both surface as
/// [`AppError::Decryption`]: callers learn that authentication failed, nothing more.
#[derive(Debug, Error)]
pub enum AppError {
    /// A feature has not been implemented yet (skeleton placeholder).
    #[error("not implemented")]
    NotImplemented,
    /// Input failed a structural check (e.g. wrong key/byte length).
    #[error("invalid input")]
    InvalidInput,
    /// Argon2id key derivation failed (e.g. invalid cost parameters).
    #[error("key derivation failed")]
    KeyDerivation,
    /// HKDF key expansion failed.
    #[error("key expansion failed")]
    KeyExpansion,
    /// The OS cryptographic RNG failed to produce randomness.
    #[error("secure random generation failed")]
    Random,
    /// AEAD encryption failed.
    #[error("encryption failed")]
    Encryption,
    /// AEAD decryption/authentication failed (wrong key or tampered ciphertext).
    #[error("decryption failed")]
    Decryption,
    /// An operation requiring an unlocked vault was attempted while locked.
    #[error("vault is locked")]
    Locked,
    /// The requested item does not exist.
    #[error("item not found")]
    NotFound,
    /// (De)serialization of a non-secret structure failed.
    #[error("serialization failed")]
    Serialization,
    /// Reading or writing the vault file failed.
    #[error("storage error")]
    Storage,
}

/// Convenient result alias used throughout the crate.
pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_message_does_not_leak_internals() {
        // A stable, non-leaking message is the whole point of the typed error.
        assert_eq!(AppError::NotImplemented.to_string(), "not implemented");
    }
}
