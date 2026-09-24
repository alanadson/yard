use std::path::PathBuf;
use std::process::Command;

fn main() {
    tauri_build::build();
    build_yard_cli();
}

/// Compiles the `yard` CLI client (`src/yard_cli.rs`) into its own console
/// exe in `OUT_DIR`, which `bridge.rs` embeds with `include_bytes!` and writes
/// beside the shims at startup. The client exists so every agent hook stops
/// paying a Windows PowerShell cold start (about 0.6 s each).
///
/// A separate `rustc` call rather than a cargo `[[bin]]`: a second binary of
/// this package would not end up inside the installer, and its path could not
/// be embedded in the lib. The file is std only on purpose, so the compiler
/// cargo picked for this build (`RUSTC`, for this `TARGET`) is all it needs;
/// it takes about a second and reruns only when the file changes.
fn build_yard_cli() {
    const SOURCE: &str = "src/yard_cli.rs";
    println!("cargo:rerun-if-changed={SOURCE}");
    let out = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR")).join("yard-cli.exe");

    // Nothing but Windows can run it. An empty client tells the bridge to
    // keep the PowerShell shims.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        std::fs::write(&out, b"").expect("write the empty client");
        return;
    }

    let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let target = std::env::var("TARGET").expect("TARGET");
    let mut cmd = Command::new(rustc);
    // Relative source path from the manifest dir: the panic locations baked
    // into the exe then do not depend on where the repository was cloned.
    cmd.current_dir(std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
        .args(["--edition", "2021", "--crate-type", "bin", "--crate-name", "yard_cli"])
        .args(["--target", &target])
        .args(["-C", "opt-level=2", "-C", "panic=abort", "-C", "debuginfo=0"])
        // No vcruntime DLL to find on the user's machine.
        .args(["-C", "target-feature=+crt-static"]);
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        // No PDB, and a deterministic link: the same source gives the same
        // bytes, so the content-addressed name in `<data>\bin` only changes
        // when the client really did.
        cmd.args(["-C", "link-arg=/DEBUG:NONE", "-C", "link-arg=/Brepro"]);
    }
    cmd.arg("-o").arg(&out).arg(SOURCE);

    let output = cmd.output().expect("could not start rustc to build the yard CLI client");
    if !output.status.success() {
        panic!(
            "building the yard CLI client ({SOURCE}) failed:\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
