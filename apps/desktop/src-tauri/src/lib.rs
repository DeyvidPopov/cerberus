//! Cerberus desktop security core.
//!
//! This is the Rust half of the Tauri desktop app and the *only* place crypto,
//! key material, and vault state are allowed to live (PROJECT.md §1, §4.1).
//! [`crypto`] implements the ADR-0001 key hierarchy and AEAD; [`vault`] adds
//! credential encryption, the [`vault::VaultManager`] session, and persistence.
//!
//! The crypto/vault core is pure Rust and builds/tests without Tauri. The Tauri
//! runtime and the `#[tauri::command]` FFI wrappers in [`commands`] are gated
//! behind the `desktop` feature, so the hermetic CI job compiles only the core.

#[cfg(feature = "desktop")]
pub mod commands;
pub mod crypto;
pub mod error;
pub mod vault;

pub use error::{AppError, AppResult};

/// Run the desktop application (Tauri runtime). Built only with `desktop`.
#[cfg(feature = "desktop")]
pub fn run() {
    commands::run();
}

/// Without the `desktop` feature there is no runtime — the crate is the pure
/// crypto/vault core (ADR-0003 lineage). This stub exists so the lib always has
/// a `run` symbol.
#[cfg(not(feature = "desktop"))]
pub fn run() {}
