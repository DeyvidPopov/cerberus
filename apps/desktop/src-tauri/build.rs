// Cargo build script.
//
// `tauri_build::build()` runs only for the `desktop` feature; the pure crypto/
// vault core builds with no build-time Tauri coupling (ADR-0003 lineage).
fn main() {
    #[cfg(feature = "desktop")]
    tauri_build::build();
}
