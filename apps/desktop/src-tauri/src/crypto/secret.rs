//! Typed, self-zeroizing secret material (PROJECT.md §4.1, ADR-0001).
//!
//! Every secret is a distinct newtype so they cannot be mixed up at call sites
//! (a `VaultKey` is not interchangeable with an `EncryptionKey`). All of them:
//!   - implement [`Zeroize`] + [`ZeroizeOnDrop`] so their bytes are wiped on drop;
//!   - print `[redacted]` via [`fmt::Debug`] — secrets never appear in logs;
//!   - compare in constant time via [`subtle`].

use core::fmt;

use subtle::ConstantTimeEq;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::{AppError, AppResult};

/// Length in bytes of every symmetric key in the hierarchy (256-bit).
pub const KEY_LEN: usize = 32;

/// Defines a 32-byte secret-key newtype with uniform, leak-free behaviour.
macro_rules! define_key {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Clone, Zeroize, ZeroizeOnDrop)]
        pub struct $name([u8; KEY_LEN]);

        impl $name {
            /// Construct from exactly [`KEY_LEN`] bytes.
            #[must_use]
            pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
                Self(bytes)
            }

            /// Construct from a slice, erroring if it is not [`KEY_LEN`] bytes.
            pub fn from_slice(bytes: &[u8]) -> AppResult<Self> {
                let arr: [u8; KEY_LEN] =
                    bytes.try_into().map_err(|_| AppError::InvalidInput)?;
                Ok(Self(arr))
            }

            /// Borrow the raw key bytes. Use only momentarily, at the crypto boundary.
            #[must_use]
            pub fn as_bytes(&self) -> &[u8; KEY_LEN] {
                &self.0
            }

            /// Constant-time equality (PROJECT.md §4.1 — secret comparisons).
            #[must_use]
            pub fn ct_eq(&self, other: &Self) -> bool {
                self.0.ct_eq(&other.0).into()
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(concat!(stringify!($name), "([redacted])"))
            }
        }
    };
}

define_key! {
    /// Output of Argon2id over the master password — the root of the hierarchy.
    MasterKey
}
define_key! {
    /// HKDF-derived key sent to the server as a login proof (server stores its hash).
    AuthKey
}
define_key! {
    /// HKDF-derived key that wraps the vault key. Never leaves the client.
    EncryptionKey
}
define_key! {
    /// Random per-user key that encrypts individual credentials. Stored AEAD-wrapped.
    VaultKey
}

/// A secret UTF-8 string (e.g. the master password). Zeroized on drop, redacted Debug.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct SecretString(String);

impl SecretString {
    /// Wrap an owned string as a secret.
    #[must_use]
    pub fn new(value: String) -> Self {
        Self(value)
    }

    /// Borrow the inner string. Hand to the KDF immediately; never persist or log.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl From<&str> for SecretString {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretString([redacted])")
    }
}

/// A secret byte buffer (e.g. decrypted credential plaintext). Zeroized on drop.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct SecretBytes(Vec<u8>);

impl SecretBytes {
    /// Wrap owned bytes as a secret.
    #[must_use]
    pub fn new(value: Vec<u8>) -> Self {
        Self(value)
    }

    /// Borrow the inner bytes. Use only as long as necessary; never log.
    #[must_use]
    pub fn expose(&self) -> &[u8] {
        &self.0
    }

    /// Number of secret bytes held.
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Whether the buffer is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Constant-time equality.
    #[must_use]
    pub fn ct_eq(&self, other: &Self) -> bool {
        self.0.ct_eq(&other.0).into()
    }
}

impl fmt::Debug for SecretBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretBytes([redacted])")
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn debug_never_leaks_key_bytes() {
        let key = MasterKey::from_bytes([0xAB; KEY_LEN]);
        let rendered = format!("{key:?}");
        assert_eq!(rendered, "MasterKey([redacted])");
        assert!(!rendered.contains("ab"));
        assert!(!rendered.contains("171"));
    }

    #[test]
    fn debug_never_leaks_secret_string() {
        let secret = SecretString::from("hunter2");
        assert_eq!(format!("{secret:?}"), "SecretString([redacted])");
        assert!(!format!("{secret:?}").contains("hunter2"));
    }

    #[test]
    fn debug_never_leaks_secret_bytes() {
        let secret = SecretBytes::new(vec![1, 2, 3, 4]);
        assert_eq!(format!("{secret:?}"), "SecretBytes([redacted])");
    }

    #[test]
    fn ct_eq_matches_equality() {
        let a = VaultKey::from_bytes([7u8; KEY_LEN]);
        let b = VaultKey::from_bytes([7u8; KEY_LEN]);
        let c = VaultKey::from_bytes([8u8; KEY_LEN]);
        assert!(a.ct_eq(&b));
        assert!(!a.ct_eq(&c));
    }

    #[test]
    fn from_slice_rejects_wrong_length() {
        assert!(MasterKey::from_slice(&[0u8; KEY_LEN - 1]).is_err());
        assert!(MasterKey::from_slice(&[0u8; KEY_LEN]).is_ok());
    }
}
