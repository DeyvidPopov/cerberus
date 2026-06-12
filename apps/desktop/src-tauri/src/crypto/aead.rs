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
