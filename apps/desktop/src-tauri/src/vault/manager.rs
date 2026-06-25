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

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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

/// The pre-scoping local vault filename (a SINGLE file per machine). Newer builds scope
/// the vault file per account; this name is kept only so an existing single-file vault
/// can be MIGRATED to its owner's per-account file on first unlock (see `unlock`).
const LEGACY_VAULT_FILE: &str = "vault.json";

/// Plaintext credential fields. Secret: serialized to JSON, then AEAD-encrypted.
/// No `Debug` impl, by design — this must never be logged.
///
/// The first five fields are the original login shape; the rest are additive,
/// per-item metadata stored INSIDE the same encrypted blob (so the server never sees
/// them) and are `#[serde(default)]` for backward compatibility — a blob written by
/// an older client simply deserializes them to their defaults. `item_type` selects the
/// presentation (`""`/`"login"` | `"card"` | `"note"`); `otp_secret` is an optional
/// per-item TOTP seed (the vault acts as the authenticator); the `card_*` fields hold a
/// payment card. `rename_all = camelCase` keeps the on-wire/at-rest keys camelCase
/// (single-word names are unchanged, so existing blobs still open).
#[derive(Clone, Default, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct CredentialData {
    pub name: String,
    pub username: String,
    pub password: String,
    pub url: String,
    pub notes: String,
    #[serde(default)]
    pub item_type: String,
    #[serde(default)]
    pub favourite: bool,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub otp_secret: String,
    #[serde(default)]
    pub password_updated_at: String,
    #[serde(default)]
    pub card_number: String,
    #[serde(default)]
    pub card_expiry: String,
    #[serde(default)]
    pub card_cvv: String,
    #[serde(default)]
    pub card_holder: String,
}

/// A full credential returned by `get` (non-secret id + the plaintext fields, incl.
/// the additive per-item metadata). No `Debug` impl, by design.
#[derive(Clone, Default, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct CredentialRecord {
    pub id: String,
    pub name: String,
    pub username: String,
    pub password: String,
    pub url: String,
    pub notes: String,
    pub item_type: String,
    pub favourite: bool,
    pub category: String,
    pub otp_secret: String,
    pub password_updated_at: String,
    pub card_number: String,
    pub card_expiry: String,
    pub card_cvv: String,
    pub card_holder: String,
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
            item_type: item_type_or_login(&data.item_type),
            favourite: data.favourite,
            category: data.category.clone(),
            otp_secret: data.otp_secret.clone(),
            password_updated_at: data.password_updated_at.clone(),
            card_number: data.card_number.clone(),
            card_expiry: data.card_expiry.clone(),
            card_cvv: data.card_cvv.clone(),
            card_holder: data.card_holder.clone(),
        }
    }
}

/// Non-secret-ish list entry for the UI: id + display fields + the metadata the
/// sidebar/list needs (type, favourite, category, whether a per-item OTP exists) — but
/// NEVER the password, card number, CVV, notes, or the OTP seed itself. No `Debug` impl,
/// by design (still user data — PROJECT.md §5).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSummary {
    pub id: String,
    pub name: String,
    pub username: String,
    pub url: String,
    pub item_type: String,
    pub favourite: bool,
    pub category: String,
    pub has_otp: bool,
}

/// A credential pulled from the server, ready to merge into the local vault. The
/// plaintext `data` was decrypted from the server blob IN RUST (it never crosses to
/// the webview); `revision` is the server's optimistic-concurrency counter. No
/// `Debug` impl, by design (carries plaintext — PROJECT.md §5).
pub struct PulledCredential {
    pub id: String,
    pub revision: u64,
    pub data: CredentialData,
}

/// Counts from a pull-merge: server items added, server-newer updates applied, and
/// local copies kept (server revision ≤ local).
#[derive(Debug, Default, Clone, Copy)]
pub struct MergeOutcome {
    pub added: usize,
    pub updated: usize,
    pub kept: usize,
}

/// In-memory state held only while the vault is unlocked.
struct Unlocked {
    vault_key: VaultKey,
    file: VaultFile,
    /// The per-account store this session reads/writes (chosen at unlock from the
    /// account identity), so saves target the right file.
    store: VaultStore,
}

/// The vault session. Locked until [`VaultManager::unlock`] succeeds.
pub struct VaultManager {
    /// Directory holding the per-account vault files; the specific file is chosen at
    /// unlock from the account identity (so two accounts on one machine never collide).
    base_dir: PathBuf,
    /// KDF params used only when initializing a brand-new vault; an existing
    /// vault is re-derived with the params recorded in its file.
    init_params: KdfParams,
    unlocked: Option<Unlocked>,
}

impl VaultManager {
    /// Create a locked manager whose per-account vault files live under `base_dir`,
    /// initializing new vaults with the pinned production KDF params ([`KdfParams::V1`],
    /// ADR-0001).
    pub fn new(base_dir: PathBuf) -> Self {
        Self::with_init_params(base_dir, KdfParams::V1)
    }

    /// Like [`Self::new`] but choosing the KDF params used when initializing a new
    /// vault. Used by tests to avoid the ~0.5 s production cost on every unlock.
    pub fn with_init_params(base_dir: PathBuf, init_params: KdfParams) -> Self {
        Self {
            base_dir,
            init_params,
            unlocked: None,
        }
    }

    /// Whether the vault is currently unlocked.
    pub fn is_unlocked(&self) -> bool {
        self.unlocked.is_some()
    }

    /// The per-account vault file for `vault_id`. The id (the account's username) is
    /// SHA-256-hashed so the filename is filesystem-safe and does NOT reveal the account
    /// name on disk (PROJECT.md §5).
    fn store_for(&self, vault_id: &str) -> VaultStore {
        let digest = Sha256::digest(vault_id.as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        VaultStore::new(self.base_dir.join(format!("vault-{hex}.json")))
    }

    /// Unlock the vault for the account identified by `vault_id` (its username). The
    /// vault file is scoped to that account, so two accounts on one machine each get
    /// their own vault and never collide.
    ///
    /// Resolution order:
    ///   1. the account's per-account file exists → verify the password by unwrapping
    ///      its key (a wrong password fails as [`AppError::Decryption`], no panic);
    ///   2. no per-account file, but a legacy single-file vault exists AND this password
    ///      opens it → MIGRATE it to this account's file (the pre-scoping owner keeps
    ///      their locally-stored items);
    ///   3. otherwise → initialize a fresh vault for this account (first run).
    ///
    /// The `password` is consumed and zeroized when this returns.
    pub fn unlock(&mut self, password: SecretString, vault_id: &str) -> AppResult<()> {
        let store = self.store_for(vault_id);
        if let Some(file) = store.load()? {
            return self.unlock_existing(&password, file, store);
        }
        if let Some((file, vault_key)) = self.load_adoptable_legacy(&password)? {
            // One-time migration: copy the legacy single-file vault into this account's
            // per-account file (the legacy file is left in place, harmlessly shadowed).
            store.save(&file)?;
            self.unlocked = Some(Unlocked {
                vault_key,
                file,
                store,
            });
            return Ok(());
        }
        self.initialize(&password, store)
    }

    /// Derive the vault key from a stored file + password without mutating self — the
    /// shared core of unlock and the legacy-adoption probe. A wrong password surfaces as
    /// [`AppError::Decryption`].
    fn open_file(password: &SecretString, file: &VaultFile) -> AppResult<VaultKey> {
        let params = file.kdf_params();
        let salt = file.salt_bytes()?;
        let master = derive_master_key(password, &salt, &params)?;
        let enc = derive_encryption_key(&master)?;
        let wrapped = file.wrapped()?;
        unwrap_vault_key(&enc, &wrapped)
    }

    /// If a legacy single-file vault exists AND this password opens it, return it (and its
    /// key) for adoption. Returns `None` if there is no legacy file or it belongs to a
    /// DIFFERENT account (its password does not open it — a clean [`AppError::Decryption`]),
    /// so the caller initializes a fresh vault instead.
    fn load_adoptable_legacy(
        &self,
        password: &SecretString,
    ) -> AppResult<Option<(VaultFile, VaultKey)>> {
        let legacy = VaultStore::new(self.base_dir.join(LEGACY_VAULT_FILE));
        let Some(file) = legacy.load()? else {
            return Ok(None);
        };
        match Self::open_file(password, &file) {
            Ok(vault_key) => Ok(Some((file, vault_key))),
            Err(AppError::Decryption) => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn unlock_existing(
        &mut self,
        password: &SecretString,
        file: VaultFile,
        store: VaultStore,
    ) -> AppResult<()> {
        let vault_key = Self::open_file(password, &file)?;
        self.unlocked = Some(Unlocked {
            vault_key,
            file,
            store,
        });
        Ok(())
    }

    fn initialize(&mut self, password: &SecretString, store: VaultStore) -> AppResult<()> {
        let mut salt = [0u8; SALT_LEN];
        getrandom::getrandom(&mut salt).map_err(|_| AppError::Random)?;

        let params = self.init_params;
        let master = derive_master_key(password, &salt, &params)?;
        let enc = derive_encryption_key(&master)?;
        let vault_key = generate_vault_key()?;
        let wrapped = wrap_vault_key(&enc, &vault_key)?;

        let file = VaultFile::new(params, &salt, &wrapped);
        store.save(&file)?;
        salt.zeroize();

        self.unlocked = Some(Unlocked {
            vault_key,
            file,
            store,
        });
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

    /// Add a credential, returning its new id. Revision 0 marks it as locally
    /// created and not yet synced to the server (a later push assigns a revision).
    pub fn add(&mut self, data: &CredentialData) -> AppResult<String> {
        let u = self.unlocked.as_mut().ok_or(AppError::Locked)?;
        let blob = encrypt_to_blob(&u.vault_key, data)?;
        let id = Uuid::new_v4().to_string();
        u.file.items.push(StoredItem {
            id: id.clone(),
            blob,
            revision: 0,
        });
        u.store.save(&u.file)?;
        Ok(id)
    }

    /// Merge credentials PULLED from the server into the local vault, reconciling by
    /// revision (ADR-0008 optimistic-concurrency counter). This is a PULL only —
    /// server → local — so push and deletion are out of scope (the follow-up).
    ///
    /// Reconciliation rule (documented contract):
    ///   * item present in BOTH (same id): the HIGHER revision wins. A strictly
    ///     higher server revision REPLACES the local copy; an equal-or-lower server
    ///     revision KEEPS the local copy (so a local edit made at the same base
    ///     revision is not clobbered by a re-pull).
    ///   * item on the SERVER only: ADDED locally.
    ///   * item LOCAL only: PRESERVED (never deleted in a pull).
    ///
    /// Each pulled credential is re-encrypted under the LOCAL vault key (the local
    /// and server stores hold independent vault keys), so the decrypted plaintext
    /// never leaves Rust. The vault file is saved once if anything changed.
    pub fn merge_pulled(&mut self, pulled: &[PulledCredential]) -> AppResult<MergeOutcome> {
        let u = self.unlocked.as_mut().ok_or(AppError::Locked)?;
        let mut outcome = MergeOutcome::default();
        for item in pulled {
            match u.file.items.iter().position(|i| i.id == item.id) {
                Some(idx) => {
                    if item.revision > u.file.items[idx].revision {
                        u.file.items[idx].blob = encrypt_to_blob(&u.vault_key, &item.data)?;
                        u.file.items[idx].revision = item.revision;
                        outcome.updated += 1;
                    } else {
                        outcome.kept += 1;
                    }
                }
                None => {
                    let blob = encrypt_to_blob(&u.vault_key, &item.data)?;
                    u.file.items.push(StoredItem {
                        id: item.id.clone(),
                        blob,
                        revision: item.revision,
                    });
                    outcome.added += 1;
                }
            }
        }
        if outcome.added > 0 || outcome.updated > 0 {
            u.store.save(&u.file)?;
        }
        Ok(outcome)
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
                url: data.url.clone(),
                item_type: item_type_or_login(&data.item_type),
                favourite: data.favourite,
                category: data.category.clone(),
                has_otp: !data.otp_secret.is_empty(),
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
        u.store.save(&u.file)?;
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
        u.store.save(&u.file)?;
        Ok(())
    }
}

/// Map an empty/legacy `item_type` to the default `"login"`, so the camelCase DTO that
/// crosses to the UI always carries a valid `ItemType` (a pre-feature blob omits the
/// field → serde defaults it to `""`).
fn item_type_or_login(raw: &str) -> String {
    if raw.is_empty() {
        "login".to_owned()
    } else {
        raw.to_owned()
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
            item_type: String::new(),
            favourite: false,
            category: String::new(),
            otp_secret: String::new(),
            password_updated_at: String::new(),
            card_number: String::new(),
            card_expiry: String::new(),
            card_cvv: String::new(),
            card_holder: String::new(),
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

    /// A default account id for tests that don't exercise per-account scoping.
    const ID: &str = "tester";

    fn temp_manager() -> (VaultManager, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        (
            VaultManager::with_init_params(dir.path().to_path_buf(), cheap_params()),
            dir,
        )
    }

    /// Re-open a manager over the SAME directory (the second-session / reinstall case).
    fn manager_at(dir: &tempfile::TempDir) -> VaultManager {
        VaultManager::with_init_params(dir.path().to_path_buf(), cheap_params())
    }

    #[test]
    fn add_list_get_round_trip() {
        let (mut m, _dir) = temp_manager();
        m.unlock(SecretString::from("master-pw"), ID).unwrap();

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
    fn per_item_fields_round_trip_and_summary_omits_secrets() {
        let (mut m, _dir) = temp_manager();
        m.unlock(SecretString::from("master-pw"), ID).unwrap();

        let data = CredentialData {
            name: "Hulu".to_owned(),
            username: "scottlaw@gmail.com".to_owned(),
            password: "hulu-pw".to_owned(),
            url: "https://hulu.com".to_owned(),
            notes: String::new(),
            item_type: "login".to_owned(),
            favourite: true,
            category: "Streaming".to_owned(),
            otp_secret: "JBSWY3DPEHPK3PXP".to_owned(),
            password_updated_at: "2022-09-01T00:00:00Z".to_owned(),
            card_number: String::new(),
            card_expiry: String::new(),
            card_cvv: String::new(),
            card_holder: String::new(),
        };
        let id = m.add(&data).unwrap();

        // `get` round-trips every per-item field.
        let got = m.get(&id).unwrap();
        assert!(got.favourite);
        assert_eq!(got.category, "Streaming");
        assert_eq!(got.item_type, "login");
        assert_eq!(got.otp_secret, "JBSWY3DPEHPK3PXP");
        assert_eq!(got.password_updated_at, "2022-09-01T00:00:00Z");

        // `list` exposes the metadata the UI needs …
        let list = m.list().unwrap();
        assert!(list[0].favourite);
        assert_eq!(list[0].category, "Streaming");
        assert!(list[0].has_otp);
        // … but a summary NEVER carries the password, the OTP seed, or notes (PROJECT.md §5).
        let summary_json = serde_json::to_string(&list[0]).unwrap();
        assert!(!summary_json.contains("hulu-pw"));
        assert!(!summary_json.contains("JBSWY3DPEHPK3PXP"));
        assert!(!summary_json.contains("\"password\""));
        assert!(!summary_json.contains("\"otpSecret\""));
    }

    #[test]
    fn old_blob_without_new_fields_deserializes_to_defaults() {
        // A blob written by an OLDER client (the original five fields only) must still
        // open — the additive fields fall back to their serde defaults (back-compat).
        let old_json = r#"{"name":"n","username":"u","password":"p","url":"x","notes":"z"}"#;
        let data: CredentialData = serde_json::from_str(old_json).unwrap();
        assert_eq!(data.name, "n");
        assert_eq!(data.password, "p");
        assert_eq!(data.item_type, "");
        assert!(!data.favourite);
        assert_eq!(data.otp_secret, "");
        assert_eq!(data.card_number, "");
    }

    #[test]
    fn update_changes_contents() {
        let (mut m, _dir) = temp_manager();
        m.unlock(SecretString::from("master-pw"), ID).unwrap();
        let id = m.add(&sample("a")).unwrap();

        let mut edited = sample("a");
        edited.password = "rotated-pw".to_owned();
        m.update(&id, &edited).unwrap();

        assert_eq!(m.get(&id).unwrap().password, "rotated-pw");
    }

    #[test]
    fn delete_removes_credential() {
        let (mut m, _dir) = temp_manager();
        m.unlock(SecretString::from("master-pw"), ID).unwrap();
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

        m.unlock(SecretString::from("master-pw"), ID).unwrap();
        assert!(m.is_unlocked());
        m.lock();
        assert!(!m.is_unlocked());
        // After lock, no access without re-unlock.
        assert!(matches!(m.list(), Err(AppError::Locked)));
    }

    #[test]
    fn wrong_master_password_fails_cleanly() {
        let (mut m, dir) = temp_manager();

        // Initialize the vault, add an item, then lock.
        m.unlock(SecretString::from("correct-pw"), ID).unwrap();
        m.add(&sample("a")).unwrap();
        m.lock();

        // A fresh manager over the same account (same id): a wrong password must fail as
        // a clean Err (decryption), never panic, and leave the vault locked.
        let mut m2 = manager_at(&dir);
        let result = m2.unlock(SecretString::from("WRONG-pw"), ID);
        assert!(matches!(result, Err(AppError::Decryption)));
        assert!(!m2.is_unlocked());
    }

    #[test]
    fn persistence_round_trip_across_managers() {
        let (mut m, dir) = temp_manager();

        m.unlock(SecretString::from("master-pw"), ID).unwrap();
        let id = m.add(&sample("github")).unwrap();
        m.lock(); // drop keys

        // Re-unlock from disk in a brand-new manager (same account) and decrypt.
        let mut m2 = manager_at(&dir);
        m2.unlock(SecretString::from("master-pw"), ID).unwrap();
        let got = m2.get(&id).unwrap();
        assert_eq!(got.password, "github_PLAINTEXT_PW");
    }

    #[test]
    fn on_disk_file_contains_no_plaintext() {
        let (mut m, dir) = temp_manager();

        m.unlock(SecretString::from("master-PLAINTEXT-PW"), ID)
            .unwrap();
        m.add(&sample("github")).unwrap();

        // The vault file is now per-account (`vault-<hash>.json`); read whichever one was written.
        let written = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().starts_with("vault-"))
            .expect("a per-account vault file was written");
        let bytes = fs::read(written.path()).unwrap();
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
        m.unlock(SecretString::from("master-pw"), ID).unwrap();
        assert!(matches!(m.get("nope"), Err(AppError::NotFound)));
        assert!(matches!(
            m.update("nope", &sample("a")),
            Err(AppError::NotFound)
        ));
        assert!(matches!(m.delete("nope"), Err(AppError::NotFound)));
    }

    fn pulled(id: &str, revision: u64, name: &str) -> PulledCredential {
        PulledCredential {
            id: id.to_owned(),
            revision,
            data: sample(name),
        }
    }

    // PULL into a fresh/empty local vault (the multi-device / reinstall case): every
    // server item is added, and each is recoverable (re-encrypted under the local key).
    #[test]
    fn merge_pulled_into_empty_vault_adds_all() {
        let (mut m, _dir) = temp_manager();
        m.unlock(SecretString::from("pw"), ID).unwrap();

        let outcome = m
            .merge_pulled(&[pulled("a", 1, "GitHub"), pulled("b", 2, "Email")])
            .unwrap();
        assert_eq!((outcome.added, outcome.updated, outcome.kept), (2, 0, 0));
        assert_eq!(m.list().unwrap().len(), 2);
        assert_eq!(m.get("a").unwrap().name, "GitHub");
        assert_eq!(m.get("b").unwrap().password, "Email_PLAINTEXT_PW");
    }

    // Reconcile by revision: a strictly higher server revision REPLACES local; an
    // equal-or-lower server revision KEEPS local (a local edit is not clobbered).
    #[test]
    fn merge_pulled_reconciles_by_revision() {
        let (mut m, _dir) = temp_manager();
        m.unlock(SecretString::from("pw"), ID).unwrap();
        m.merge_pulled(&[pulled("x", 5, "local-v5")]).unwrap();

        // Higher server revision wins.
        let up = m.merge_pulled(&[pulled("x", 6, "server-v6")]).unwrap();
        assert_eq!((up.added, up.updated, up.kept), (0, 1, 0));
        assert_eq!(m.get("x").unwrap().name, "server-v6");

        // Equal revision is kept (local edit preserved).
        let eq = m.merge_pulled(&[pulled("x", 6, "should-not-win")]).unwrap();
        assert_eq!((eq.added, eq.updated, eq.kept), (0, 0, 1));
        assert_eq!(m.get("x").unwrap().name, "server-v6");

        // Lower revision is kept.
        let lo = m.merge_pulled(&[pulled("x", 3, "older")]).unwrap();
        assert_eq!((lo.added, lo.updated, lo.kept), (0, 0, 1));
        assert_eq!(m.get("x").unwrap().name, "server-v6");
    }

    // A server-only item is added; a local-only item is PRESERVED (pull never deletes).
    #[test]
    fn merge_pulled_adds_server_only_and_preserves_local_only() {
        let (mut m, _dir) = temp_manager();
        m.unlock(SecretString::from("pw"), ID).unwrap();
        let local_id = m.add(&sample("local-only")).unwrap();

        let outcome = m
            .merge_pulled(&[pulled("server-1", 1, "server-only")])
            .unwrap();
        assert_eq!((outcome.added, outcome.updated, outcome.kept), (1, 0, 0));

        let ids: Vec<String> = m.list().unwrap().into_iter().map(|s| s.id).collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&local_id)); // local-only preserved
        assert!(ids.iter().any(|i| i == "server-1")); // server-only added
    }

    // The merge is persisted: a fresh manager re-unlocking the same file sees it
    // (the reinstall path — the local vault was reconstructed and saved).
    #[test]
    fn merge_pulled_persists_across_relock() {
        let (mut m, dir) = temp_manager();
        m.unlock(SecretString::from("pw"), ID).unwrap();
        m.merge_pulled(&[pulled("a", 3, "GitHub")]).unwrap();
        m.lock();

        let mut m2 = manager_at(&dir);
        m2.unlock(SecretString::from("pw"), ID).unwrap();
        assert_eq!(m2.get("a").unwrap().password, "GitHub_PLAINTEXT_PW");
    }

    // THE FIX (multi-account on one machine): two different accounts must each get their
    // OWN vault file. Before scoping, the second account hit the first's single `vault.json`
    // and failed to unwrap it (Decryption) — which surfaced in the UI as a never-ending
    // "vault is locked → log in to unlock" loop.
    #[test]
    fn different_accounts_get_independent_vaults() {
        let (mut a, dir) = temp_manager();
        a.unlock(SecretString::from("pw-A"), "alice").unwrap();
        a.add(&sample("alice-secret")).unwrap();
        a.lock();

        // Bob: a DIFFERENT account + password on the SAME machine opens his OWN (empty)
        // vault — he does NOT inherit or fail against alice's.
        let mut b = manager_at(&dir);
        b.unlock(SecretString::from("pw-B"), "bob").unwrap();
        assert!(b.is_unlocked());
        assert!(b.list().unwrap().is_empty());

        // Alice still opens her own vault with her own password.
        let mut a2 = manager_at(&dir);
        a2.unlock(SecretString::from("pw-A"), "alice").unwrap();
        assert_eq!(a2.list().unwrap().len(), 1);
    }

    // A pre-scoping single `vault.json` is MIGRATED to its owner's per-account file on the
    // first unlock (so the original owner keeps their locally-stored items), while a
    // DIFFERENT account is unaffected and simply gets a fresh vault.
    #[test]
    fn migrates_a_legacy_single_file_vault_to_its_owner() {
        let dir = tempfile::tempdir().unwrap();

        // Build a vault, then rename its per-account file to the legacy `vault.json` to
        // simulate data written by a pre-scoping build.
        {
            let mut m = manager_at(&dir);
            m.unlock(SecretString::from("owner-pw"), "owner").unwrap();
            m.add(&sample("legacy-item")).unwrap();
        }
        let per_account = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().starts_with("vault-"))
            .expect("a per-account vault file was written")
            .path();
        fs::rename(&per_account, dir.path().join("vault.json")).unwrap();

        // A DIFFERENT account unlocking against the (valid) legacy file does NOT adopt it
        // (wrong password) — it gets a fresh empty vault and crucially does NOT error (the
        // loop bug). The legacy file is left untouched for its real owner.
        {
            let mut other = manager_at(&dir);
            other
                .unlock(SecretString::from("intruder-pw"), "intruder")
                .unwrap();
            assert!(other.is_unlocked());
            assert!(other.list().unwrap().is_empty());
        }

        // The owner unlocks: the legacy file is adopted, items preserved.
        let mut owner = manager_at(&dir);
        owner
            .unlock(SecretString::from("owner-pw"), "owner")
            .unwrap();
        assert_eq!(owner.list().unwrap().len(), 1);
        assert_eq!(owner.list().unwrap()[0].name, "legacy-item");
        owner.lock();

        // Migration persisted to the per-account file: a re-unlock no longer needs the
        // legacy file at all.
        fs::remove_file(dir.path().join("vault.json")).unwrap();
        let mut owner2 = manager_at(&dir);
        owner2
            .unlock(SecretString::from("owner-pw"), "owner")
            .unwrap();
        assert_eq!(owner2.list().unwrap().len(), 1);
    }
}
