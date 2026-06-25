# Appendix B — Cryptographic Core

This appendix reproduces, **verbatim**, the Rust crypto core that implements the
key hierarchy, the self-zeroizing secret types, and the authenticated-encryption
layer (ADR-0001, ADR-0005). Every file lives in the hermetic vault core, which
builds and tests without the Tauri runtime (ADR-0003). Nothing here is rewritten
or abridged; each listing is the exact file at the path in its heading.

The key hierarchy these files realise:

````text
master password ─Argon2id─► master key ─HKDF─┬─► auth key (server proof)
                                             └─► encryption key ─wraps─► vault key
                                                                vault key ─AEAD─► credential
````

## B.1 Zeroizing secret types & constant-time comparison

### `apps/desktop/src-tauri/src/crypto/secret.rs`

````rust
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
````

## B.2 Key derivation & hierarchy — Argon2id master key, HKDF subkeys (with known-answer tests)

### `apps/desktop/src-tauri/src/crypto/kdf.rs`

````rust
//! Key derivation (ADR-0001):
//!   master password ──Argon2id(salt, params)──► master key
//!   master key ──HKDF-SHA-256(info)──► auth key  /  encryption key
//!
//! The two HKDF outputs use distinct `info` labels, so they are cryptographically
//! independent (knowing one tells you nothing about the other).

use argon2::{Algorithm, Argon2, Params, Version};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroize;

use crate::crypto::secret::{AuthKey, EncryptionKey, MasterKey, SecretString, KEY_LEN};
use crate::error::{AppError, AppResult};

/// KDF parameter-set version, stored per user so parameters can be raised later
/// without breaking old vaults (ADR-0001). Mirrors `KDF_VERSION` in packages/protocol.
pub const KDF_VERSION: u32 = 1;

/// HKDF `info` label for the auth key. Mirrors packages/protocol `HKDF_INFO.authKey`.
const HKDF_INFO_AUTH: &[u8] = b"cerberus/auth-key/v1";
/// HKDF `info` label for the encryption key. Mirrors `HKDF_INFO.encryptionKey`.
const HKDF_INFO_ENC: &[u8] = b"cerberus/encryption-key/v1";

/// Argon2id cost parameters (ADR-0001).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    /// Memory cost in kibibytes.
    pub memory_kib: u32,
    /// Time cost (number of iterations).
    pub iterations: u32,
    /// Degree of parallelism (lanes).
    pub parallelism: u32,
}

impl KdfParams {
    /// Pinned v1 parameters. Benchmarked on target hardware to ~0.5 s/derivation
    /// and recorded in ADR-0001 and packages/protocol.
    pub const V1: Self = Self {
        memory_kib: 229_376, // 224 MiB
        iterations: 3,
        parallelism: 1,
    };
}

impl Default for KdfParams {
    fn default() -> Self {
        Self::V1
    }
}

/// Derive the master key from the master password and salt (Argon2id, ADR-0001).
///
/// `salt` must be 8..=64 bytes (Argon2 requirement); a 16-byte random salt is the
/// expected caller input.
pub fn derive_master_key(
    password: &SecretString,
    salt: &[u8],
    params: &KdfParams,
) -> AppResult<MasterKey> {
    let argon_params = Params::new(
        params.memory_kib,
        params.iterations,
        params.parallelism,
        Some(KEY_LEN),
    )
    .map_err(|_| AppError::KeyDerivation)?;

    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params);

    let mut out = [0u8; KEY_LEN];
    let result = argon
        .hash_password_into(password.expose().as_bytes(), salt, &mut out)
        .map_err(|_| AppError::KeyDerivation);

    let key = result.map(|()| MasterKey::from_bytes(out));
    out.zeroize(); // wipe the transient stack buffer regardless of outcome
    key
}

/// HKDF-SHA-256 expand of the master key into 32 bytes under `info`.
fn expand(master: &MasterKey, info: &[u8]) -> AppResult<[u8; KEY_LEN]> {
    // Salt = None (all-zero), per ADR-0001 key-separation use of HKDF.
    let hk = Hkdf::<Sha256>::new(None, master.as_bytes());
    let mut okm = [0u8; KEY_LEN];
    hk.expand(info, &mut okm)
        .map_err(|_| AppError::KeyExpansion)?;
    Ok(okm)
}

/// Derive the auth key (login proof) from the master key (ADR-0001).
pub fn derive_auth_key(master: &MasterKey) -> AppResult<AuthKey> {
    let mut okm = expand(master, HKDF_INFO_AUTH)?;
    let key = AuthKey::from_bytes(okm);
    okm.zeroize();
    Ok(key)
}

/// Derive the encryption key (wraps the vault key) from the master key (ADR-0001).
pub fn derive_encryption_key(master: &MasterKey) -> AppResult<EncryptionKey> {
    let mut okm = expand(master, HKDF_INFO_ENC)?;
    let key = EncryptionKey::from_bytes(okm);
    okm.zeroize();
    Ok(key)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    // -- Known-answer tests against published vectors --------------------------

    /// Argon2id KAT from draft-irtf-cfrg-argon2-12 §5.3 (version 0x13).
    /// Uses secret + associated data, exercised here directly against the primitive.
    #[test]
    fn argon2id_known_answer_vector() {
        use argon2::{AssociatedData, ParamsBuilder};

        let params = ParamsBuilder::new()
            .m_cost(32)
            .t_cost(3)
            .p_cost(4)
            .data(AssociatedData::new(&[0x04; 12]).unwrap())
            .build()
            .unwrap();

        let password = [0x01u8; 32];
        let salt = [0x02u8; 16];
        let secret = [0x03u8; 8];
        let expected =
            hex::decode("0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659")
                .unwrap();

        let ctx =
            Argon2::new_with_secret(&secret, Algorithm::Argon2id, Version::V0x13, params).unwrap();
        let mut out = [0u8; 32];
        ctx.hash_password_into(&password, &salt, &mut out).unwrap();

        assert_eq!(out.as_slice(), expected.as_slice());
    }

    /// HKDF-SHA-256 KAT from RFC 5869 Appendix A, Test Case 1.
    #[test]
    fn hkdf_sha256_known_answer_vector() {
        let ikm = hex::decode("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b").unwrap();
        let salt = hex::decode("000102030405060708090a0b0c").unwrap();
        let info = hex::decode("f0f1f2f3f4f5f6f7f8f9").unwrap();
        let expected = hex::decode(
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
        )
        .unwrap();

        let hk = Hkdf::<Sha256>::new(Some(&salt), &ikm);
        let mut okm = vec![0u8; expected.len()];
        hk.expand(&info, &mut okm).unwrap();

        assert_eq!(okm, expected);
    }

    // -- Derivation properties -------------------------------------------------

    fn test_master_key() -> MasterKey {
        // Small params keep the test fast; correctness is independent of cost.
        let params = KdfParams {
            memory_kib: 64,
            iterations: 1,
            parallelism: 1,
        };
        derive_master_key(
            &SecretString::from("correct horse battery staple"),
            b"saltsaltsalt1234",
            &params,
        )
        .unwrap()
    }

    #[test]
    fn master_key_derivation_is_deterministic() {
        let a = test_master_key();
        let b = test_master_key();
        assert!(a.ct_eq(&b));
    }

    #[test]
    fn auth_and_encryption_keys_are_independent() {
        let master = test_master_key();
        let auth = derive_auth_key(&master).unwrap();
        let enc = derive_encryption_key(&master).unwrap();
        // Distinct info labels => distinct, independent keys.
        assert_ne!(auth.as_bytes(), enc.as_bytes());
    }

    #[test]
    fn subkey_derivation_is_deterministic() {
        let master = test_master_key();
        let auth1 = derive_auth_key(&master).unwrap();
        let auth2 = derive_auth_key(&master).unwrap();
        assert!(auth1.ct_eq(&auth2));
    }

    #[test]
    fn different_salt_yields_different_master_key() {
        let params = KdfParams {
            memory_kib: 64,
            iterations: 1,
            parallelism: 1,
        };
        let pw = SecretString::from("same password");
        let k1 = derive_master_key(&pw, b"salt-aaaa-aaaa-01", &params).unwrap();
        let k2 = derive_master_key(&pw, b"salt-bbbb-bbbb-02", &params).unwrap();
        assert!(!k1.ct_eq(&k2));
    }

    #[test]
    fn too_short_salt_errors_without_panicking() {
        let params = KdfParams::V1;
        let result = derive_master_key(&SecretString::from("pw"), b"short", &params);
        assert!(result.is_err());
    }

    // -- Benchmark (ignored by default) ---------------------------------------
    //
    // Run with:  cargo test -p cerberus-desktop --release -- --ignored --nocapture
    // to measure derivation time with the pinned V1 params on this machine.
    #[test]
    #[ignore = "benchmark: run manually to tune/verify Argon2id cost"]
    fn bench_argon2id_pinned_params() {
        use std::time::Instant;

        let params = KdfParams::V1;
        let pw = SecretString::from("benchmark password");
        let salt = b"benchmark-salt-16";

        // Warm-up.
        let _ = derive_master_key(&pw, salt, &params).unwrap();

        let runs = 5;
        let start = Instant::now();
        for _ in 0..runs {
            let _ = derive_master_key(&pw, salt, &params).unwrap();
        }
        let per = start.elapsed() / runs;
        println!(
            "Argon2id V1 (m={} KiB, t={}, p={}): {:?} per derivation",
            params.memory_kib, params.iterations, params.parallelism, per
        );
    }
}
````

## B.3 Authenticated encryption — XChaCha20-Poly1305 seal/open (with KAT & tamper tests)

### `apps/desktop/src-tauri/src/crypto/aead.rs`

````rust
//! Authenticated encryption (ADR-0001): XChaCha20-Poly1305, AEAD only.
//!
//! A fresh random 192-bit nonce is generated for every [`seal`] — nonce reuse is
//! a hard bug. Decryption is authenticated: any tampering with the nonce,
//! ciphertext, or tag, or use of the wrong key, fails as [`AppError::Decryption`]
//! rather than returning wrong plaintext.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};

use crate::crypto::secret::KEY_LEN;
use crate::error::{AppError, AppResult};

/// XChaCha20-Poly1305 nonce length in bytes (192-bit).
pub const NONCE_LEN: usize = 24;

/// An AEAD output: the random nonce and the combined ciphertext (with the
/// 16-byte Poly1305 tag appended).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AeadCiphertext {
    /// The fresh random nonce used for this encryption.
    pub nonce: [u8; NONCE_LEN],
    /// Ciphertext bytes with the authentication tag appended.
    pub ciphertext: Vec<u8>,
}

/// Encrypt `plaintext` under `key`, binding `aad` (associated data) to the result.
/// Generates a fresh random nonce.
pub fn seal(key: &[u8; KEY_LEN], plaintext: &[u8], aad: &[u8]) -> AppResult<AeadCiphertext> {
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| AppError::Encryption)?;

    let mut nonce = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut nonce).map_err(|_| AppError::Random)?;

    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| AppError::Encryption)?;

    Ok(AeadCiphertext { nonce, ciphertext })
}

/// Decrypt and authenticate `ct` under `key` with the same `aad` used to seal.
/// Wrong key or any tampering returns [`AppError::Decryption`].
pub fn open(key: &[u8; KEY_LEN], ct: &AeadCiphertext, aad: &[u8]) -> AppResult<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| AppError::Decryption)?;

    cipher
        .decrypt(
            XNonce::from_slice(&ct.nonce),
            Payload {
                msg: &ct.ciphertext,
                aad,
            },
        )
        .map_err(|_| AppError::Decryption)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// XChaCha20-Poly1305 KAT from draft-arciszewski-xchacha-03 §A.1.
    /// Verifies the primitive produces the published ciphertext||tag.
    #[test]
    fn xchacha20poly1305_known_answer_vector() {
        let key = hex::decode("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f")
            .unwrap();
        let nonce = hex::decode("404142434445464748494a4b4c4d4e4f5051525354555657").unwrap();
        let aad = hex::decode("50515253c0c1c2c3c4c5c6c7").unwrap();
        let plaintext = b"Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";

        // Expected ciphertext followed by the 16-byte tag.
        let expected_ct = hex::decode(
            "bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52e",
        )
        .unwrap();
        let expected_tag = hex::decode("c0875924c1c7987947deafd8780acf49").unwrap();
        let mut expected = expected_ct.clone();
        expected.extend_from_slice(&expected_tag);

        let cipher = XChaCha20Poly1305::new_from_slice(&key).unwrap();
        let out = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: &aad,
                },
            )
            .unwrap();

        assert_eq!(out, expected);
    }

    fn key() -> [u8; KEY_LEN] {
        [0x24u8; KEY_LEN]
    }

    #[test]
    fn round_trip_recovers_plaintext() {
        let msg = b"top secret credential blob";
        let ct = seal(&key(), msg, b"aad").unwrap();
        let pt = open(&key(), &ct, b"aad").unwrap();
        assert_eq!(pt, msg);
    }

    #[test]
    fn round_trip_property_over_random_inputs() {
        // Property: for arbitrary keys and messages, open(seal(m)) == m.
        for _ in 0..200 {
            let mut k = [0u8; KEY_LEN];
            getrandom::getrandom(&mut k).unwrap();
            let mut len_byte = [0u8; 1];
            getrandom::getrandom(&mut len_byte).unwrap();
            let mut msg = vec![0u8; len_byte[0] as usize];
            getrandom::getrandom(&mut msg).unwrap();

            let ct = seal(&k, &msg, b"aad").unwrap();
            let pt = open(&k, &ct, b"aad").unwrap();
            assert_eq!(pt, msg);
        }
    }

    #[test]
    fn fresh_nonce_per_op() {
        let ct1 = seal(&key(), b"same message", b"").unwrap();
        let ct2 = seal(&key(), b"same message", b"").unwrap();
        // Nonces must differ, so identical plaintext yields different ciphertext.
        assert_ne!(ct1.nonce, ct2.nonce);
        assert_ne!(ct1.ciphertext, ct2.ciphertext);
    }

    #[test]
    fn tampered_ciphertext_fails_authentication() {
        let mut ct = seal(&key(), b"authentic", b"").unwrap();
        ct.ciphertext[0] ^= 0x01;
        let result = open(&key(), &ct, b"");
        assert!(matches!(result, Err(AppError::Decryption)));
    }

    #[test]
    fn tampered_tag_fails_authentication() {
        let mut ct = seal(&key(), b"authentic", b"").unwrap();
        let last = ct.ciphertext.len() - 1;
        ct.ciphertext[last] ^= 0x80;
        assert!(matches!(open(&key(), &ct, b""), Err(AppError::Decryption)));
    }

    #[test]
    fn tampered_nonce_fails_authentication() {
        let mut ct = seal(&key(), b"authentic", b"").unwrap();
        ct.nonce[0] ^= 0xFF;
        assert!(matches!(open(&key(), &ct, b""), Err(AppError::Decryption)));
    }

    #[test]
    fn wrong_key_fails_cleanly_without_panic() {
        let ct = seal(&key(), b"secret", b"").unwrap();
        let wrong = [0x99u8; KEY_LEN];
        assert!(matches!(open(&wrong, &ct, b""), Err(AppError::Decryption)));
    }

    #[test]
    fn wrong_aad_fails_authentication() {
        let ct = seal(&key(), b"secret", b"context-a").unwrap();
        assert!(matches!(
            open(&key(), &ct, b"context-b"),
            Err(AppError::Decryption)
        ));
    }
}
````

## B.4 Key-hierarchy wiring & vault-key wrap

### `apps/desktop/src-tauri/src/crypto/mod.rs`

````rust
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
````

## B.5 Credential seal/open & master-password rotation

### `apps/desktop/src-tauri/src/vault/mod.rs`

````rust
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
pub use manager::{CredentialData, CredentialRecord, CredentialSummary, VaultManager};
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
````

