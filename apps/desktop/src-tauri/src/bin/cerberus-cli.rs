//! `cerberus-cli` — a hermetic client-crypto oracle for tests and reproducible
//! evaluation scripts (PROJECT.md §6). It is NOT part of the Tauri app and uses
//! the exact same crypto core (no reimplementation). It reads a subcommand
//! (argv[1]) and a JSON request on stdin, and writes a JSON response to stdout:
//!
//!   register         {masterPassword, kdfParams?} -> {authKey, kdfVersion, kdfParams, kdfSalt, wrappedVaultKey, wrappedVaultKeyNonce}
//!   derive-auth-key  {masterPassword, kdfSalt, kdfParams} -> {authKey}
//!   seal-credential  {masterPassword, kdfSalt, kdfParams, wrappedVaultKey, wrappedVaultKeyNonce, plaintext} -> {ciphertext, nonce}
//!   open-credential  {..., ciphertext, nonce} -> {plaintext}
//!
//! Secrets (master password, derived keys, vault key) never appear in the output:
//! only the auth key (the login proof), opaque blobs, and the requested plaintext
//! (for `open`) cross out. This binary is for automation, not a production surface.

use std::error::Error;
use std::io::Read;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};

use cerberus_desktop::crypto::{AeadCiphertext, KdfParams, SecretString, NONCE_LEN};
use cerberus_desktop::vault::account::build_registration_with_params;
use cerberus_desktop::vault::{
    decrypt_credential, derive_login_auth_key, encrypt_credential, unwrap_login_vault_key,
};

type CliResult<T> = Result<T, Box<dyn Error>>;

#[derive(Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct KdfParamsJson {
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
}

impl From<KdfParamsJson> for KdfParams {
    fn from(value: KdfParamsJson) -> Self {
        KdfParams {
            memory_kib: value.memory_kib,
            iterations: value.iterations,
            parallelism: value.parallelism,
        }
    }
}

impl From<KdfParams> for KdfParamsJson {
    fn from(value: KdfParams) -> Self {
        KdfParamsJson {
            memory_kib: value.memory_kib,
            iterations: value.iterations,
            parallelism: value.parallelism,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterReq {
    master_password: String,
    kdf_params: Option<KdfParamsJson>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisterResp {
    auth_key: String,
    kdf_version: u32,
    kdf_params: KdfParamsJson,
    kdf_salt: String,
    wrapped_vault_key: String,
    wrapped_vault_key_nonce: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeriveAuthReq {
    master_password: String,
    kdf_salt: String,
    kdf_params: KdfParamsJson,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthKeyResp {
    auth_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SealReq {
    master_password: String,
    kdf_salt: String,
    kdf_params: KdfParamsJson,
    wrapped_vault_key: String,
    wrapped_vault_key_nonce: String,
    plaintext: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BlobResp {
    ciphertext: String,
    nonce: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenReq {
    master_password: String,
    kdf_salt: String,
    kdf_params: KdfParamsJson,
    wrapped_vault_key: String,
    wrapped_vault_key_nonce: String,
    ciphertext: String,
    nonce: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaintextResp {
    plaintext: String,
}

fn aead_from(ciphertext_b64: &str, nonce_b64: &str) -> CliResult<AeadCiphertext> {
    let nonce_vec = STANDARD.decode(nonce_b64)?;
    let nonce: [u8; NONCE_LEN] = nonce_vec.try_into().map_err(|_| "invalid nonce length")?;
    let ciphertext = STANDARD.decode(ciphertext_b64)?;
    Ok(AeadCiphertext { nonce, ciphertext })
}

fn do_register(input: &str) -> CliResult<String> {
    let req: RegisterReq = serde_json::from_str(input)?;
    let params = req.kdf_params.map_or(KdfParams::V1, KdfParams::from);
    let password = SecretString::new(req.master_password);
    let material = build_registration_with_params(&password, params)?;
    let resp = RegisterResp {
        auth_key: STANDARD.encode(material.auth_key.as_bytes()),
        kdf_version: material.kdf_version,
        kdf_params: material.kdf_params.into(),
        kdf_salt: STANDARD.encode(material.kdf_salt),
        wrapped_vault_key: STANDARD.encode(&material.wrapped_vault_key.ciphertext),
        wrapped_vault_key_nonce: STANDARD.encode(material.wrapped_vault_key.nonce),
    };
    Ok(serde_json::to_string(&resp)?)
}

fn do_derive_auth_key(input: &str) -> CliResult<String> {
    let req: DeriveAuthReq = serde_json::from_str(input)?;
    let salt = STANDARD.decode(&req.kdf_salt)?;
    let password = SecretString::new(req.master_password);
    let auth_key = derive_login_auth_key(&password, &salt, &req.kdf_params.into())?;
    Ok(serde_json::to_string(&AuthKeyResp {
        auth_key: STANDARD.encode(auth_key.as_bytes()),
    })?)
}

fn do_seal(input: &str) -> CliResult<String> {
    let req: SealReq = serde_json::from_str(input)?;
    let salt = STANDARD.decode(&req.kdf_salt)?;
    let wrapped = aead_from(&req.wrapped_vault_key, &req.wrapped_vault_key_nonce)?;
    let password = SecretString::new(req.master_password);
    let vault_key = unwrap_login_vault_key(&password, &salt, &req.kdf_params.into(), &wrapped)?;
    let blob = encrypt_credential(&vault_key, req.plaintext.as_bytes())?;
    Ok(serde_json::to_string(&BlobResp {
        ciphertext: STANDARD.encode(&blob.ciphertext),
        nonce: STANDARD.encode(blob.nonce),
    })?)
}

fn do_open(input: &str) -> CliResult<String> {
    let req: OpenReq = serde_json::from_str(input)?;
    let salt = STANDARD.decode(&req.kdf_salt)?;
    let wrapped = aead_from(&req.wrapped_vault_key, &req.wrapped_vault_key_nonce)?;
    let password = SecretString::new(req.master_password);
    let vault_key = unwrap_login_vault_key(&password, &salt, &req.kdf_params.into(), &wrapped)?;
    let blob = aead_from(&req.ciphertext, &req.nonce)?;
    let plaintext = decrypt_credential(&vault_key, &blob)?;
    let text = String::from_utf8(plaintext.expose().to_vec())?;
    Ok(serde_json::to_string(&PlaintextResp { plaintext: text })?)
}

fn run() -> CliResult<()> {
    let command = std::env::args().nth(1).ok_or("missing subcommand")?;
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;

    let output = match command.as_str() {
        "register" => do_register(&input)?,
        "derive-auth-key" => do_derive_auth_key(&input)?,
        "seal-credential" => do_seal(&input)?,
        "open-credential" => do_open(&input)?,
        other => return Err(format!("unknown subcommand: {other}").into()),
    };

    println!("{output}");
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("cerberus-cli error: {error}");
        std::process::exit(1);
    }
}
