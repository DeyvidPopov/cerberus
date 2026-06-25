//! Tauri command surface — the `#[tauri::command]` FFI boundary.
//!
//! Per PROJECT.md §4.1 these handlers stay thin: they lock the shared
//! [`VaultManager`], call exactly one method, and map errors to a non-leaking
//! string. No business logic and no crypto live here — that is all in
//! [`crate::vault`]. Built only with the `desktop` feature.
//!
//! Secret handling: the master password arrives as a `String`, is moved into a
//! zeroizing [`SecretString`] immediately, and never appears in a return value,
//! log, or error. Derived keys never leave Rust.

use std::sync::{Mutex, MutexGuard};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use crate::crypto::{AeadCiphertext, KdfParams, SecretString, VaultKey, NONCE_LEN};
use crate::vault::{
    build_registration, decrypt_credential, derive_login_auth_key, encrypt_credential,
    unwrap_login_vault_key, CredentialData, CredentialRecord, CredentialSummary, PulledCredential,
    VaultManager,
};

/// Managed Tauri state: the vault session behind a mutex.
pub struct VaultState(pub Mutex<VaultManager>);

/// Public KDF params crossing the IPC boundary (camelCase to match the TS DTO).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfParamsDto {
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
}

impl From<KdfParamsDto> for KdfParams {
    fn from(dto: KdfParamsDto) -> Self {
        KdfParams {
            memory_kib: dto.memory_kib,
            iterations: dto.iterations,
            parallelism: dto.parallelism,
        }
    }
}

/// Registration material the client sends to the server (all bytes base64). The
/// vault key generated alongside is NOT included — it never leaves Rust.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationMaterialDto {
    pub auth_key: String,
    pub kdf_version: u32,
    pub kdf_params: KdfParamsDto,
    pub kdf_salt: String,
    pub wrapped_vault_key: String,
    pub wrapped_vault_key_nonce: String,
}

/// Derive registration material from the master password (ADR-0001). The master
/// password is wrapped in a zeroizing secret and never leaves Rust; only the auth
/// key, public KDF params, and the opaque wrapped vault key are returned.
///
/// Argon2id (~0.5 s release / several seconds in a debug build) is CPU-bound, so it
/// runs on a BLOCKING-SAFE thread via `spawn_blocking`: an `async` command keeps it
/// off the webview main thread, so the UI never freezes during derivation. The
/// password is moved into the closure, wrapped in a zeroizing secret there, and
/// wiped when the closure returns — it never leaves Rust.
#[tauri::command]
pub async fn prepare_registration(
    master_password: String,
) -> Result<RegistrationMaterialDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let secret = SecretString::new(master_password);
        let material = build_registration(&secret).map_err(|e| e.to_string())?;
        Ok(RegistrationMaterialDto {
            auth_key: STANDARD.encode(material.auth_key.as_bytes()),
            kdf_version: material.kdf_version,
            kdf_params: KdfParamsDto {
                memory_kib: material.kdf_params.memory_kib,
                iterations: material.kdf_params.iterations,
                parallelism: material.kdf_params.parallelism,
            },
            kdf_salt: STANDARD.encode(material.kdf_salt),
            wrapped_vault_key: STANDARD.encode(&material.wrapped_vault_key.ciphertext),
            wrapped_vault_key_nonce: STANDARD.encode(material.wrapped_vault_key.nonce),
        })
    })
    .await
    .map_err(|_| "key derivation was interrupted".to_owned())?
}

/// Derive the login auth key from the master password and the KDF params returned
/// by prelogin. Returns the base64 auth key to send to the server; the master
/// password never leaves Rust. Argon2id runs on a blocking-safe thread (see
/// `prepare_registration`) so the UI does not freeze.
#[tauri::command]
pub async fn derive_login_auth_key_cmd(
    master_password: String,
    kdf_salt: String,
    kdf_params: KdfParamsDto,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let secret = SecretString::new(master_password);
        let salt = STANDARD
            .decode(&kdf_salt)
            .map_err(|_| "invalid salt".to_owned())?;
        let params: KdfParams = kdf_params.into();
        let auth_key = derive_login_auth_key(&secret, &salt, &params).map_err(|e| e.to_string())?;
        Ok(STANDARD.encode(auth_key.as_bytes()))
    })
    .await
    .map_err(|_| "key derivation was interrupted".to_owned())?
}

/// An AEAD blob crossing the IPC boundary (base64 nonce + ciphertext, ADR-0005).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobDto {
    pub ciphertext: String,
    pub nonce: String,
}

fn aead_from(ciphertext_b64: &str, nonce_b64: &str) -> Result<AeadCiphertext, String> {
    let nonce_vec = STANDARD
        .decode(nonce_b64)
        .map_err(|_| "invalid nonce".to_owned())?;
    let nonce: [u8; NONCE_LEN] = nonce_vec
        .try_into()
        .map_err(|_| "invalid nonce length".to_owned())?;
    let ciphertext = STANDARD
        .decode(ciphertext_b64)
        .map_err(|_| "invalid ciphertext".to_owned())?;
    Ok(AeadCiphertext { nonce, ciphertext })
}

/// Encrypt a credential to an opaque blob for sync (ADR-0005). Re-derives the
/// vault key from the master password + wrapped vault key; nothing secret is
/// returned (only the opaque ciphertext + nonce).
#[tauri::command]
pub async fn seal_credential(
    master_password: String,
    kdf_salt: String,
    kdf_params: KdfParamsDto,
    wrapped_vault_key: String,
    wrapped_vault_key_nonce: String,
    plaintext: String,
) -> Result<BlobDto, String> {
    // Re-derives the vault key (Argon2id) → run off the main thread (no UI freeze).
    tauri::async_runtime::spawn_blocking(move || {
        let salt = STANDARD
            .decode(&kdf_salt)
            .map_err(|_| "invalid salt".to_owned())?;
        let wrapped = aead_from(&wrapped_vault_key, &wrapped_vault_key_nonce)?;
        let secret = SecretString::new(master_password);
        let vault_key = unwrap_login_vault_key(&secret, &salt, &kdf_params.into(), &wrapped)
            .map_err(|e| e.to_string())?;
        let blob =
            encrypt_credential(&vault_key, plaintext.as_bytes()).map_err(|e| e.to_string())?;
        Ok(BlobDto {
            ciphertext: STANDARD.encode(&blob.ciphertext),
            nonce: STANDARD.encode(blob.nonce),
        })
    })
    .await
    .map_err(|_| "key derivation was interrupted".to_owned())?
}

/// Decrypt an opaque blob pulled from the server back to its plaintext. Re-derives
/// the vault key (Argon2id) on a blocking-safe thread so the UI does not freeze.
#[tauri::command]
pub async fn open_credential(
    master_password: String,
    kdf_salt: String,
    kdf_params: KdfParamsDto,
    wrapped_vault_key: String,
    wrapped_vault_key_nonce: String,
    ciphertext: String,
    nonce: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let salt = STANDARD
            .decode(&kdf_salt)
            .map_err(|_| "invalid salt".to_owned())?;
        let wrapped = aead_from(&wrapped_vault_key, &wrapped_vault_key_nonce)?;
        let secret = SecretString::new(master_password);
        let vault_key = unwrap_login_vault_key(&secret, &salt, &kdf_params.into(), &wrapped)
            .map_err(|e| e.to_string())?;
        let blob = aead_from(&ciphertext, &nonce)?;
        let plaintext = decrypt_credential(&vault_key, &blob).map_err(|e| e.to_string())?;
        String::from_utf8(plaintext.expose().to_vec()).map_err(|_| "invalid utf-8".to_owned())
    })
    .await
    .map_err(|_| "key derivation was interrupted".to_owned())?
}

/// One encrypted item fetched from the server, to be merged into the local vault
/// (camelCase to match the TS DTO). `revision` is the optimistic-concurrency value.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerItemDto {
    pub id: String,
    pub revision: u64,
    pub ciphertext: String,
    pub nonce: String,
}

/// Result of a pull-merge crossing back to the webview (counts only — no secrets).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcomeDto {
    pub added: usize,
    pub updated: usize,
    pub kept: usize,
    pub skipped: usize,
}

struct DecryptedItems {
    pulled: Vec<PulledCredential>,
    skipped: usize,
}

/// Decode one server blob and decrypt it under the (server) vault key into the
/// plaintext credential fields. Any failure (tamper, wrong key, bad JSON) is an Err.
fn decode_and_decrypt(
    vault_key: &VaultKey,
    item: &ServerItemDto,
) -> Result<CredentialData, String> {
    let blob = aead_from(&item.ciphertext, &item.nonce)?;
    let plaintext = decrypt_credential(vault_key, &blob).map_err(|e| e.to_string())?;
    serde_json::from_slice(plaintext.expose()).map_err(|_| "invalid credential json".to_owned())
}

/// Derive the SERVER vault key (Argon2id) and decrypt every server blob, SKIPPING any
/// that fail to decrypt (fail safe — a corrupt blob must never crash the unlock). The
/// decrypted plaintext stays in Rust. Pure (no manager state) so it runs off-thread.
fn decrypt_server_items(
    master_password: String,
    kdf_salt: &str,
    kdf_params: KdfParams,
    wrapped_vault_key: &str,
    wrapped_vault_key_nonce: &str,
    items: Vec<ServerItemDto>,
) -> Result<DecryptedItems, String> {
    let salt = STANDARD
        .decode(kdf_salt)
        .map_err(|_| "invalid salt".to_owned())?;
    let wrapped = aead_from(wrapped_vault_key, wrapped_vault_key_nonce)?;
    let secret = SecretString::new(master_password);
    let vault_key =
        unwrap_login_vault_key(&secret, &salt, &kdf_params, &wrapped).map_err(|e| e.to_string())?;

    let mut pulled = Vec::with_capacity(items.len());
    let mut skipped = 0usize;
    for item in items {
        match decode_and_decrypt(&vault_key, &item) {
            Ok(data) => pulled.push(PulledCredential {
                id: item.id,
                revision: item.revision,
                data,
            }),
            Err(_) => {
                // Fail safe: skip a corrupt/undecryptable blob (only its opaque id is
                // noted; never plaintext or identity). The unlock still succeeds.
                skipped += 1;
                eprintln!("vault sync: skipping undecryptable item {}", item.id);
            }
        }
    }
    Ok(DecryptedItems { pulled, skipped })
}

/// PULL on unlock (ADR-0008): fetch the user's encrypted server items, decrypt them
/// client-side with the SERVER vault key (re-derived from the master password — the
/// SAME `derive_master_key → encryption key → unwrap vault key` path the app already
/// uses), and MERGE them into the local vault under the local vault key, reconciled
/// by revision (higher wins; server-only added; local-only preserved; corrupt blobs
/// skipped). The server only ever holds ciphertext; decryption is client-side only.
#[tauri::command]
pub async fn sync_pull_merge(
    state: State<'_, VaultState>,
    master_password: String,
    kdf_salt: String,
    kdf_params: KdfParamsDto,
    wrapped_vault_key: String,
    wrapped_vault_key_nonce: String,
    items: Vec<ServerItemDto>,
) -> Result<MergeOutcomeDto, String> {
    let params: KdfParams = kdf_params.into();
    // Heavy crypto (Argon2id + per-item AEAD) off the webview main thread.
    let decrypted = tauri::async_runtime::spawn_blocking(move || {
        decrypt_server_items(
            master_password,
            &kdf_salt,
            params,
            &wrapped_vault_key,
            &wrapped_vault_key_nonce,
            items,
        )
    })
    .await
    .map_err(|_| "vault sync was interrupted".to_owned())??;

    let merged = manager(&state)?
        .merge_pulled(&decrypted.pulled)
        .map_err(|e| e.to_string())?;
    Ok(MergeOutcomeDto {
        added: merged.added,
        updated: merged.updated,
        kept: merged.kept,
        skipped: decrypted.skipped,
    })
}

/// Lock the shared manager, mapping mutex poisoning to a generic error.
fn manager<'a>(state: &'a State<'_, VaultState>) -> Result<MutexGuard<'a, VaultManager>, String> {
    state.0.lock().map_err(|_| "vault unavailable".to_owned())
}

/// Unlock (or, on first run, initialize) the vault for the account `vault_id` (its
/// username) with the master password. The vault file is scoped to the account, so two
/// accounts on one machine each get their own vault and never collide.
#[tauri::command]
pub fn unlock(
    state: State<'_, VaultState>,
    master_password: String,
    vault_id: String,
) -> Result<(), String> {
    // Move the password into a zeroizing secret immediately; it is wiped when
    // `unlock` returns (the borrow ends and the SecretString drops).
    let secret = SecretString::new(master_password);
    manager(&state)?
        .unlock(secret, &vault_id)
        .map_err(|e| e.to_string())
}

/// Lock the vault, zeroizing all in-memory keys.
#[tauri::command]
pub fn lock(state: State<'_, VaultState>) -> Result<(), String> {
    manager(&state)?.lock();
    Ok(())
}

/// Add a credential; returns its new id.
#[tauri::command]
pub fn add_credential(
    state: State<'_, VaultState>,
    input: CredentialData,
) -> Result<String, String> {
    manager(&state)?.add(&input).map_err(|e| e.to_string())
}

/// List credentials as non-secret summaries.
#[tauri::command]
pub fn list_credentials(state: State<'_, VaultState>) -> Result<Vec<CredentialSummary>, String> {
    manager(&state)?.list().map_err(|e| e.to_string())
}

/// Fetch a full credential by id.
#[tauri::command]
pub fn get_credential(
    state: State<'_, VaultState>,
    id: String,
) -> Result<CredentialRecord, String> {
    manager(&state)?.get(&id).map_err(|e| e.to_string())
}

/// Replace a credential's contents.
#[tauri::command]
pub fn update_credential(
    state: State<'_, VaultState>,
    id: String,
    input: CredentialData,
) -> Result<(), String> {
    manager(&state)?
        .update(&id, &input)
        .map_err(|e| e.to_string())
}

/// Delete a credential by id.
#[tauri::command]
pub fn delete_credential(state: State<'_, VaultState>, id: String) -> Result<(), String> {
    manager(&state)?.delete(&id).map_err(|e| e.to_string())
}

/// Build and run the Tauri application.
///
/// The vault file lives in the OS app-data directory. No `unwrap`/`expect`/
/// `panic` crosses startup: a fatal error is reported and the process exits
/// non-zero (fail closed).
pub fn run() {
    let result = tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            // Per-account vault files live under this directory; the specific file is
            // chosen at unlock from the account identity (so multiple accounts on one
            // machine never collide on a single shared vault).
            app.manage(VaultState(Mutex::new(VaultManager::new(dir))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            prepare_registration,
            derive_login_auth_key_cmd,
            seal_credential,
            open_credential,
            sync_pull_merge,
            unlock,
            lock,
            add_credential,
            list_credentials,
            get_credential,
            update_credential,
            delete_credential
        ])
        .run(tauri::generate_context!());

    if let Err(error) = result {
        eprintln!("fatal: failed to start Cerberus: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    // Cheap KDF params keep these tests fast: the command derives with whatever
    // params it is GIVEN (the pinned ~0.5 s production cost is not exercised here).
    fn cheap_params() -> KdfParamsDto {
        KdfParamsDto {
            memory_kib: 16,
            iterations: 1,
            parallelism: 1,
        }
    }

    // Regression guard for the async + spawn_blocking conversion (commit 60e7048):
    // the SUCCESS path — derive returns the auth key, not an error or wrong shape —
    // and that key equals what the crypto core derives directly (no corruption from
    // running off the main thread). Mirrors the M9 login: register and a later login
    // derive the SAME auth key from the same password + salt + params.
    #[test]
    fn derive_login_auth_key_cmd_returns_the_crypto_core_key() {
        let pw = "correct horse battery staple".to_owned();
        let salt = [9u8; 16];
        let salt_b64 = STANDARD.encode(salt);
        let params = cheap_params();

        let got = tauri::async_runtime::block_on(derive_login_auth_key_cmd(
            pw.clone(),
            salt_b64,
            params.clone(),
        ))
        .expect("derive command must return the auth key, not an error");

        let expected_key =
            derive_login_auth_key(&SecretString::new(pw), &salt, &KdfParams::from(params))
                .expect("crypto-core derive");
        assert_eq!(got, STANDARD.encode(expected_key.as_bytes()));
        assert!(!got.is_empty());
    }

    // The same password + salt + params must derive the SAME key every time, so a
    // login can match the auth-key hash stored at registration.
    #[test]
    fn derive_login_auth_key_cmd_is_deterministic() {
        let salt_b64 = STANDARD.encode([3u8; 16]);
        let a = tauri::async_runtime::block_on(derive_login_auth_key_cmd(
            "pw".to_owned(),
            salt_b64.clone(),
            cheap_params(),
        ))
        .unwrap();
        let b = tauri::async_runtime::block_on(derive_login_auth_key_cmd(
            "pw".to_owned(),
            salt_b64,
            cheap_params(),
        ))
        .unwrap();
        assert_eq!(a, b);
    }

    // prepare_registration's success path returns usable, base64 material off-thread.
    #[test]
    fn prepare_registration_returns_material() {
        let material =
            tauri::async_runtime::block_on(prepare_registration("hunter2".to_owned())).unwrap();
        assert!(STANDARD.decode(&material.auth_key).is_ok());
        assert!(STANDARD.decode(&material.wrapped_vault_key).is_ok());
        assert_eq!(material.kdf_version, 1); // pinned Argon2id V1 (ADR-0001)
    }

    // A malformed salt is a clean Err (fail closed), never a panic crossing the FFI.
    #[test]
    fn derive_login_auth_key_cmd_rejects_a_bad_salt() {
        let r = tauri::async_runtime::block_on(derive_login_auth_key_cmd(
            "pw".to_owned(),
            "!!not-base64!!".to_owned(),
            cheap_params(),
        ));
        assert!(r.is_err());
    }

    // The PULL path end to end (the reinstall / multi-device case): decrypt real
    // server blobs with the re-derived server vault key, SKIP a corrupt one (fail
    // safe), then merge into a FRESH local vault and read every credential back.
    #[test]
    fn sync_pull_decrypts_skips_corrupt_and_reconstructs_a_fresh_vault() {
        use crate::vault::account::build_registration_with_params;
        use crate::vault::VaultManager;

        let pw = "sync-master-pw";
        let material = build_registration_with_params(
            &SecretString::new(pw.to_owned()),
            cheap_params().into(),
        )
        .unwrap();

        // Seal credentials under the SERVER vault key (what the server stores).
        let seal = |name: &str| -> ServerItemDto {
            let data = CredentialData {
                name: name.to_owned(),
                username: format!("{name}@example.com"),
                password: format!("{name}-secret"),
                url: String::new(),
                notes: String::new(),
                item_type: String::new(),
                favourite: false,
                category: String::new(),
                otp_secret: String::new(),
                password_updated_at: String::new(),
                card_number: String::new(),
                card_expiry: String::new(),
                card_cvv: String::new(),
                card_holder: String::new(),
            };
            let json = serde_json::to_vec(&data).unwrap();
            let ct = encrypt_credential(&material.vault_key, &json).unwrap();
            ServerItemDto {
                id: name.to_owned(),
                revision: 1,
                ciphertext: STANDARD.encode(&ct.ciphertext),
                nonce: STANDARD.encode(ct.nonce),
            }
        };
        let items = vec![
            seal("GitHub"),
            seal("Email"),
            // A corrupt blob (well-formed base64, not a real ciphertext) → skipped.
            ServerItemDto {
                id: "corrupt".to_owned(),
                revision: 1,
                ciphertext: STANDARD.encode([7u8; 48]),
                nonce: STANDARD.encode([9u8; NONCE_LEN]),
            },
        ];

        let decrypted = decrypt_server_items(
            pw.to_owned(),
            &STANDARD.encode(material.kdf_salt),
            material.kdf_params,
            &STANDARD.encode(&material.wrapped_vault_key.ciphertext),
            &STANDARD.encode(material.wrapped_vault_key.nonce),
            items,
        )
        .unwrap();
        assert_eq!(decrypted.pulled.len(), 2);
        assert_eq!(decrypted.skipped, 1); // the corrupt blob was skipped, not fatal

        // Merge into a FRESH local vault (independent local vault key) and read back.
        let dir = tempfile::tempdir().unwrap();
        let mut m = VaultManager::with_init_params(dir.path().to_path_buf(), cheap_params().into());
        m.unlock(SecretString::from("local-only-pw"), "tester")
            .unwrap();
        let outcome = m.merge_pulled(&decrypted.pulled).unwrap();
        assert_eq!((outcome.added, outcome.updated), (2, 0));
        assert_eq!(m.list().unwrap().len(), 2);
        assert_eq!(m.get("GitHub").unwrap().password, "GitHub-secret");
    }
}
