//! Regenerate the checked-in frontend bindings without starting the desktop app.

fn main() -> Result<(), String> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/desktop/bindings.ts");
    yard_lib::desktop::contracts::export(&path)
}
