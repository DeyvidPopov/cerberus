//! The vault session manager — pure Rust, no Tauri (ADR-0003 lineage).
//!
//! Holds the in-memory unlocked state (the vault key + the loaded encrypted
//! file) and implements unlock/lock and credential CRUD. The `#[tauri::command]`
//! wrappers in [`crate::commands`] are thin adapters over this type, so all the
//! logic here is unit-testable with `cargo test` and runs in the hermetic CI job.
//!
//! Secret hygiene: the master password and derived keys live only here, in Rust;
//! `lock()` drops the unlocked state, whose `VaultKey` is `ZeroizeOnDrop`.
//! Credential plaintext is decrypted on demand and the transient buffers are
//! zeroized; the structs that carry plaintext deliberately have **no `Debug`**,
//! so a credential can never be accidentally logged.

use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::crypto::{
    derive_encryption_key, derive_master_key, generate_vault_key, unwrap_vault_key, wrap_vault_key,
    KdfParams, SecretBytes, SecretString, VaultKey,
};
use crate::error::{AppError, AppResult};
use crate::vault::store::{StoredBlob, StoredItem, VaultFile, VaultStore};
use crate::vault::{decrypt_credential, encrypt_credential};

/// Length of the per-vault KDF salt in bytes.
const SALT_LEN: usize = 16;

/// Plaintext credential fields. Secret: serialized to JSON, then AEAD-encrypted.
/// No `Debug` impl, by design — this must never be logged.
#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct CredentialData {
    pub name: String,
    pub username: String,
    pub password: String,
    pub url: String,
    pub notes: String,
}

/// A full credential returned by `get` (non-secret id + the plaintext fields).
/// No `Debug` impl, by design.
#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct CredentialRecord {
    pub id: String,
    pub name: String,
    pub username: String,
    pub password: String,
    pub url: String,
    pub notes: String,
}

impl CredentialRecord {
    fn from_parts(id: String, data: &CredentialData) -> Self {
        Self {
            id,
            name: data.name.clone(),
            username: data.username.clone(),
            password: data.password.clone(),
            url: data.url.clone(),
            notes: data.notes.clone(),
        }
    }
}

/// Non-secret-ish list entry for the UI (id + display fields, no password).
/// No `Debug` impl, by design (still user data — PROJECT.md §5).
#[derive(Clone, Serialize, Deserialize)]
pub struct CredentialSummary {
    pub id: String,
    pub name: String,
    pub username: String,
}

/// In-memory state held only while the vault is unlocked.
struct Unlocked {
    vault_key: VaultKey,
    file: VaultFile,
}

/// The vault session. Locked until [`VaultManager::unlock`] succeeds.
pub struct VaultManager {
    store: VaultStore,
    /// KDF params used only when initializing a brand-new vault; an existing
    /// vault is re-derived with the params recorded in its file.
    init_params: KdfParams,
    unlocked: Option<Unlocked>,
}

impl VaultManager {
    /// Create a locked manager backed by `store`, initializing new vaults with
    /// the pinned production KDF params ([`KdfParams::V1`], ADR-0001).
    pub fn new(store: VaultStore) -> Self {
        Self::with_init_params(store, KdfParams::V1)
    }

    /// Like [`Self::new`] but choosing the KDF params used when initializing a new
    /// vault. Used by tests to avoid the ~0.5 s production cost on every unlock.
    pub fn with_init_params(store: VaultStore, init_params: KdfParams) -> Self {
        Self {
            store,
            init_params,
            unlocked: None,
        }
    }

    /// Whether the vault is currently unlocked.
    pub fn is_unlocked(&self) -> bool {
        self.unlocked.is_some()
    }

    /// Unlock with the master password. If no vault file exists yet (first run),
    /// a new vault is initialized with this password. Otherwise the password is
    /// verified by unwrapping the stored vault key — a wrong password fails as
    /// [`AppError::Decryption`] without panicking.
    ///
    /// The `password` is consumed and zeroized when this returns.
    pub fn unlock(&mut self, password: SecretString) -> AppResult<()> {
        match self.store.load()? {
            Some(file) => self.unlock_existing(&password, file),
            None => self.initialize(&password),
        }
    }

    fn unlock_existing(&mut self, password: &SecretString, file: VaultFile) -> AppResult<()> {
        let params = file.kdf_params();
        let salt = file.salt_bytes()?;
        let master = derive_master_key(password, &salt, &params)?;
        let enc = derive_encryption_key(&master)?;
        let wrapped = file.wrapped()?;
        let vault_key = unwrap_vault_key(&enc, &wrapped)?;
        self.unlocked = Some(Unlocked { vault_key, file });
        Ok(())
    }

    fn initialize(&mut self, password: &SecretString) -> AppResult<()> {
        let mut salt = [0u8; SALT_LEN];
        getrandom::getrandom(&mut salt).map_err(|_| AppError::Random)?;

        let params = self.init_params;
        let master = derive_master_key(password, &salt, &params)?;
        let enc = derive_encryption_key(&master)?;
        let vault_key = generate_vault_key()?;
        let wrapped = wrap_vault_key(&enc, &vault_key)?;

        let file = VaultFile::new(params, &salt, &wrapped);
        self.store.save(&file)?;
        salt.zeroize();

        self.unlocked = Some(Unlocked { vault_key, file });
        Ok(())
    }

    /// Lock the vault: drop all in-memory key material (the `VaultKey` is
    /// zeroized on drop).
    pub fn lock(&mut self) {
        self.unlocked = None;
    }

    fn unlocked(&self) -> AppResult<&Unlocked> {
        self.unlocked.as_ref().ok_or(AppError::Locked)
    }

    /// Add a credential, returning its new id.
    pub fn add(&mut self, data: &CredentialData) -> AppResult<String> {
        let u = self.unlocked.as_mut().ok_or(AppError::Locked)?;
        let blob = encrypt_to_blob(&u.vault_key, data)?;
        let id = Uuid::new_v4().to_string();
        u.file.items.push(StoredItem {
            id: id.clone(),
            blob,
        });
        self.store.save(&u.file)?;
        Ok(id)
    }

    /// List all credentials as non-secret summaries (id + name + username).
    pub fn list(&self) -> AppResult<Vec<CredentialSummary>> {
        let u = self.unlocked()?;
        let mut out = Vec::with_capacity(u.file.items.len());
        for item in &u.file.items {
            let data = decrypt_from_blob(&u.vault_key, &item.blob)?;
            out.push(CredentialSummary {
                id: item.id.clone(),
                name: data.name.clone(),
                username: data.username.clone(),
            });
        }
        Ok(out)
    }

    /// Fetch a full credential by id.
    pub fn get(&self, id: &str) -> AppResult<CredentialRecord> {
        let u = self.unlocked()?;
        let item = u
            .file
            .items
            .iter()
            .find(|i| i.id == id)
            .ok_or(AppError::NotFound)?;
        let data = decrypt_from_blob(&u.vault_key, &item.blob)?;
        Ok(CredentialRecord::from_parts(id.to_string(), &data))
    }

    /// Replace an existing credential's contents.
    pub fn update(&mut self, id: &str, data: &CredentialData) -> AppResult<()> {
        let u = self.unlocked.as_mut().ok_or(AppError::Locked)?;
        let blob = encrypt_to_blob(&u.vault_key, data)?;
        let item = u
            .file
            .items
            .iter_mut()
            .find(|i| i.id == id)
            .ok_or(AppError::NotFound)?;
        item.blob = blob;
        self.store.save(&u.file)?;
        Ok(())
    }

    /// Delete a credential by id.
    pub fn delete(&mut self, id: &str) -> AppResult<()> {
        let u = self.unlocked.as_mut().ok_or(AppError::Locked)?;
        let before = u.file.items.len();
        u.file.items.retain(|i| i.id != id);
        if u.file.items.len() == before {
            return Err(AppError::NotFound);
        }
        self.store.save(&u.file)?;
        Ok(())
    }
}

/// Serialize a credential to JSON, encrypt under the vault key, encode for storage.
/// The transient JSON plaintext is held in a zeroizing buffer.
fn encrypt_to_blob(vault_key: &VaultKey, data: &CredentialData) -> AppResult<StoredBlob> {
    let json = serde_json::to_vec(data).map_err(|_| AppError::Serialization)?;
    let plaintext = SecretBytes::new(json);
    let ct = encrypt_credential(vault_key, plaintext.expose())?;
    Ok(StoredBlob::encode(&ct))
}

/// Decode + decrypt a stored blob back into credential fields. The transient
/// plaintext is zeroized when this returns.
fn decrypt_from_blob(vault_key: &VaultKey, blob: &StoredBlob) -> AppResult<CredentialData> {
    let ct = blob.decode()?;
    let plaintext = decrypt_credential(vault_key, &ct)?;
    serde_json::from_slice(plaintext.expose()).map_err(|_| AppError::Serialization)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::fs;

    fn sample(name: &str) -> CredentialData {
        CredentialData {
            name: name.to_owned(),
            username: format!("{name}_user"),
            password: format!("{name}_PLAINTEXT_PW"),
            url: format!("https://{name}.example"),
            notes: "synthetic note".to_owned(),
        }
    }

    /// Cheap KDF params so tests don't pay the ~0.5 s production cost per unlock.
    fn cheap_params() -> KdfParams {
        KdfParams {
            memory_kib: 64,
            iterations: 1,
            parallelism: 1,
        }
    }

    fn temp_manager() -> (VaultManager, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.json");
        (
            VaultManager::with_init_params(VaultStore::new(path), cheap_params()),
            dir,
        )
    }

    #[test]
    fn add_list_get_round_trip() {
        let (mut m, _dir) = temp_manager();
        m.unlock(SecretString::from("master-pw")).unwrap();

        let id = m.add(&sample("github")).unwrap();
        let list = m.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, id);
        assert_eq!(list[0].name, "github");
        assert_eq!(list[0].username, "github_user");

        let got = m.get(&id).unwrap();
        assert_eq!(got.password, "github_PLAINTEXT_PW");
        assert_eq!(got.url, "https://github.example");
    }

    #[test]
    fn update_changes_contents() {
        let (mut m, _dir) = temp_manager();
        m.unlock(SecretString::from("master-pw")).unwrap();
        let id = m.add(&sample("a")).unwrap();

        let mut edited = sample("a");
        edited.password = "rotated-pw".to_owned();
        m.update(&id, &edited).unwrap();

        assert_eq!(m.get(&id).unwrap().password, "rotated-pw");
    }

    #[test]
    fn delete_removes_credential() {
        let (mut m, _dir) = temp_manager();
        m.unlock(SecretString::from("master-pw")).unwrap();
        let id = m.add(&sample("a")).unwrap();
        m.delete(&id).unwrap();
        assert!(m.list().unwrap().is_empty());
        assert!(matches!(m.get(&id), Err(AppError::NotFound)));
    }

    #[test]
    fn locked_operations_fail_cleanly() {
        let (mut m, _dir) = temp_manager();
        // Locked before any unlock.
        assert!(!m.is_unlocked());
        assert!(matches!(m.list(), Err(AppError::Locked)));
        assert!(matches!(m.add(&sample("a")), Err(AppError::Locked)));

        m.unlock(SecretString::from("master-pw")).unwrap();
        assert!(m.is_unlocked());
        m.lock();
        assert!(!m.is_unlocked());
        // After lock, no access without re-unlock.
        assert!(matches!(m.list(), Err(AppError::Locked)));
    }

    #[test]
    fn wrong_master_password_fails_cleanly() {
        let (mut m, dir) = temp_manager();
        let path = dir.path().join("vault.json");

        // Initialize the vault, add an item, then lock.
        m.unlock(SecretString::from("correct-pw")).unwrap();
        m.add(&sample("a")).unwrap();
        m.lock();

        // A fresh manager over the same file: wrong password must fail as a clean
        // Err (decryption), never panic, and leave the vault locked.
        let mut m2 = VaultManager::new(VaultStore::new(path));
        let result = m2.unlock(SecretString::from("WRONG-pw"));
        assert!(matches!(result, Err(AppError::Decryption)));
        assert!(!m2.is_unlocked());
    }

    #[test]
    fn persistence_round_trip_across_managers() {
        let (mut m, dir) = temp_manager();
        let path = dir.path().join("vault.json");

        m.unlock(SecretString::from("master-pw")).unwrap();
        let id = m.add(&sample("github")).unwrap();
        m.lock(); // drop keys

        // Re-unlock from disk in a brand-new manager and decrypt.
        let mut m2 = VaultManager::new(VaultStore::new(path));
        m2.unlock(SecretString::from("master-pw")).unwrap();
        let got = m2.get(&id).unwrap();
        assert_eq!(got.password, "github_PLAINTEXT_PW");
    }

    #[test]
    fn on_disk_file_contains_no_plaintext() {
        let (mut m, dir) = temp_manager();
        let path = dir.path().join("vault.json");

        m.unlock(SecretString::from("master-PLAINTEXT-PW")).unwrap();
        m.add(&sample("github")).unwrap();

        let bytes = fs::read(&path).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        // No credential plaintext, no master password, no field markers on disk.
        assert!(!text.contains("github_PLAINTEXT_PW"));
        assert!(!text.contains("master-PLAINTEXT-PW"));
        assert!(!text.contains("github_user"));
        assert!(!text.contains("synthetic note"));
        // Sanity: the file *does* contain the public structure.
        assert!(text.contains("wrapped_vault_key"));
        assert!(text.contains("\"version\""));
    }

    #[test]
    fn no_op_on_unknown_id() {
        let (mut m, _dir) = temp_manager();
        m.unlock(SecretString::from("master-pw")).unwrap();
        assert!(matches!(m.get("nope"), Err(AppError::NotFound)));
        assert!(matches!(
            m.update("nope", &sample("a")),
            Err(AppError::NotFound)
        ));
        assert!(matches!(m.delete("nope"), Err(AppError::NotFound)));
    }
}
