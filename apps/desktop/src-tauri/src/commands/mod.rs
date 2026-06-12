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

use crate::crypto::{KdfParams, SecretString};
use crate::vault::{
    build_registration, derive_login_auth_key, CredentialData, CredentialRecord, CredentialSummary,
    VaultManager, VaultStore,
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
#[tauri::command]
pub fn prepare_registration(master_password: String) -> Result<RegistrationMaterialDto, String> {
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
}

/// Derive the login auth key from the master password and the KDF params returned
/// by prelogin. Returns the base64 auth key to send to the server; the master
/// password never leaves Rust.
#[tauri::command]
pub fn derive_login_auth_key_cmd(
    master_password: String,
    kdf_salt: String,
    kdf_params: KdfParamsDto,
) -> Result<String, String> {
    let secret = SecretString::new(master_password);
    let salt = STANDARD
        .decode(&kdf_salt)
        .map_err(|_| "invalid salt".to_owned())?;
    let params: KdfParams = kdf_params.into();
    let auth_key = derive_login_auth_key(&secret, &salt, &params).map_err(|e| e.to_string())?;
    Ok(STANDARD.encode(auth_key.as_bytes()))
}

/// Lock the shared manager, mapping mutex poisoning to a generic error.
fn manager<'a>(state: &'a State<'_, VaultState>) -> Result<MutexGuard<'a, VaultManager>, String> {
    state.0.lock().map_err(|_| "vault unavailable".to_owned())
}

/// Unlock (or, on first run, initialize) the vault with the master password.
#[tauri::command]
pub fn unlock(state: State<'_, VaultState>, master_password: String) -> Result<(), String> {
    // Move the password into a zeroizing secret immediately; it is wiped when
    // `unlock` returns (the borrow ends and the SecretString drops).
    let secret = SecretString::new(master_password);
    manager(&state)?.unlock(secret).map_err(|e| e.to_string())
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
            let store = VaultStore::new(dir.join("vault.json"));
            app.manage(VaultState(Mutex::new(VaultManager::new(store))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            prepare_registration,
            derive_login_auth_key_cmd,
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
