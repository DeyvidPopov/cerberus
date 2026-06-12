//! Thin binary entry point (the Tauri app; built only with the `desktop` feature).
//!
//! Per PROJECT.md §4.1 the command/FFI boundary stays thin: all real work lives
//! in the library crate. This binary only hands control to [`cerberus_desktop::run`].
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    cerberus_desktop::run();
}
