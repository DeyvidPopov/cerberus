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
