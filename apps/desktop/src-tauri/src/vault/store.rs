//! On-disk vault persistence (ADR-0005 wire format).
//!
//! The file contains ONLY ciphertext and the public KDF params/salt needed to
//! re-derive keys — never a plaintext credential, master password, or key.
//! Each AEAD blob is stored as the ADR-0005 layout (24-byte nonce + ct‖tag),
//! base64-encoded for a text file. This is the only component that touches disk.

use std::fs;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::crypto::{AeadCiphertext, KdfParams, KDF_VERSION, NONCE_LEN};
use crate::error::{AppError, AppResult};

/// On-disk vault format version (ADR-0005 — versioned so it can evolve safely).
const VAULT_FILE_VERSION: u32 = 1;

/// A persisted AEAD blob: base64 nonce + base64 ciphertext‖tag (ADR-0005).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredBlob {
    pub nonce: String,
    pub ciphertext: String,
}

impl StoredBlob {
    /// Encode an in-memory AEAD ciphertext for storage.
    pub fn encode(ct: &AeadCiphertext) -> Self {
        Self {
            nonce: STANDARD.encode(ct.nonce),
            ciphertext: STANDARD.encode(&ct.ciphertext),
        }
    }

    /// Decode back into an in-memory AEAD ciphertext, validating the nonce length.
    pub fn decode(&self) -> AppResult<AeadCiphertext> {
        let nonce_vec = STANDARD
            .decode(&self.nonce)
            .map_err(|_| AppError::Serialization)?;
        let nonce: [u8; NONCE_LEN] = nonce_vec.try_into().map_err(|_| AppError::InvalidInput)?;
        let ciphertext = STANDARD
            .decode(&self.ciphertext)
            .map_err(|_| AppError::Serialization)?;
        Ok(AeadCiphertext { nonce, ciphertext })
    }
}

/// Public KDF parameters + salt needed to re-derive keys on unlock. NOT secret.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredKdf {
    pub version: u32,
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
    /// base64-encoded salt.
    pub salt: String,
}

/// One persisted credential: a non-secret id plus its encrypted blob, and the
/// server `revision` it was last reconciled at (optimistic-concurrency counter,
/// ADR-0008). `#[serde(default)]` keeps older vault files (no revision) loadable —
/// they read back as revision 0, so the first server pull (revision ≥ 1) wins.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredItem {
    pub id: String,
    pub blob: StoredBlob,
    #[serde(default)]
    pub revision: u64,
}

/// The whole vault file. Contains ONLY ciphertext + public KDF params/salt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultFile {
    pub version: u32,
    pub kdf: StoredKdf,
    pub wrapped_vault_key: StoredBlob,
    pub items: Vec<StoredItem>,
}

impl VaultFile {
    /// Build a fresh, empty vault file from the chosen KDF params, salt, and the
    /// wrapped vault key.
    pub fn new(params: KdfParams, salt: &[u8], wrapped: &AeadCiphertext) -> Self {
        Self {
            version: VAULT_FILE_VERSION,
            kdf: StoredKdf {
                version: KDF_VERSION,
                memory_kib: params.memory_kib,
                iterations: params.iterations,
                parallelism: params.parallelism,
                salt: STANDARD.encode(salt),
            },
            wrapped_vault_key: StoredBlob::encode(wrapped),
            items: Vec::new(),
        }
    }

    /// The KDF cost parameters recorded in this file.
    pub fn kdf_params(&self) -> KdfParams {
        KdfParams {
            memory_kib: self.kdf.memory_kib,
            iterations: self.kdf.iterations,
            parallelism: self.kdf.parallelism,
        }
    }

    /// The decoded KDF salt.
    pub fn salt_bytes(&self) -> AppResult<Vec<u8>> {
        STANDARD
            .decode(&self.kdf.salt)
            .map_err(|_| AppError::Serialization)
    }

    /// The decoded wrapped-vault-key blob.
    pub fn wrapped(&self) -> AppResult<AeadCiphertext> {
        self.wrapped_vault_key.decode()
    }
}

/// Reads/writes the vault file at a fixed path.
pub struct VaultStore {
    path: PathBuf,
}

impl VaultStore {
    /// Create a store backed by the file at `path` (not read until [`Self::load`]).
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// The backing file path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Load the vault file, or `None` if it does not exist yet (first run).
    pub fn load(&self) -> AppResult<Option<VaultFile>> {
        match fs::read(&self.path) {
            Ok(bytes) => {
                let file = serde_json::from_slice(&bytes).map_err(|_| AppError::Serialization)?;
                Ok(Some(file))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(AppError::Storage),
        }
    }

    /// Persist the vault file. Writes to a temp file then renames, so a crash
    /// mid-write cannot corrupt an existing vault.
    pub fn save(&self, file: &VaultFile) -> AppResult<()> {
        let json = serde_json::to_vec_pretty(file).map_err(|_| AppError::Serialization)?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|_| AppError::Storage)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, &json).map_err(|_| AppError::Storage)?;
        fs::rename(&tmp, &self.path).map_err(|_| AppError::Storage)?;
        Ok(())
    }
}
