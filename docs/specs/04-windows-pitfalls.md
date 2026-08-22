# Windows-specific pitfalls (survival checklist)

1. **ConPTY has quirks.** Aggressive repaint on resize (the agent "flickers"),
   extra cursor-positioning sequences in the first frame. Debounce the resize
   on the front (~1 frame) and don't try to "clean up" the output — pass the
   raw bytes straight through to xterm.
2. **`pwsh` ≠ `powershell` ≠ `cmd`.** PowerShell 7 (`pwsh.exe`) is not always
   installed; resolve with `which` and fall back to
   `windows\System32\WindowsPowerShell\v1.0\powershell.exe`. Offer all three
   in the new-terminal modal.
3. **npm CLIs are `.cmd` shims.** `claude`, `codex` etc. installed via npm
   become `claude.cmd` in `%APPDATA%\npm`. `CreateProcess` does not execute
   `.cmd` directly: either resolve the real target, or spawn
   `cmd.exe /c claude.cmd <args>` inside the PTY. The CLI resolver
   (`agents/resolver.rs`) exists because of this — the shims have more cases
   than they seem to (`.cmd`, `.ps1`, registry, installs outside the PATH);
   budget time for it.
4. **UTF-8 in the console.** Set `TERM=xterm-256color` and consider launching
   shells with codepage 65001 (`chcp 65001` in the profile or
   `cmd /c chcp 65001 >nul && ...`) so accented characters come out right in
   older tools.
5. **Long paths and UNC.** Enable `longPathAware` in the manifest if you are
   going to deal with deep `node_modules`; beware of `\?\` in paths coming
   from git.
6. **Orphan processes are complaint #1** about terminal apps on Windows.
   Job Objects with `KILL_ON_JOB_CLOSE`
   ([PTY engine §5](./03-pty-engine.md#5-tree-kill-job-objects--fallback))
   from F1 on — don't leave it for later.
7. **SmartScreen/Defender.** Unsigned binary = blue warning screen and
   possible heuristic quarantine (an app that spawns many child processes
   looks suspicious). An EV/OV signature solves it; open source projects can
   get a free certificate through the SignPath Foundation. In the meantime,
   document the "Run anyway" step.
8. **WebView2 missing** on frozen corporate Windows 10 → the bundle's
   `downloadBootstrapper` handles it.
9. **HiDPI and zoom.** Test at 125%/150%: the `FitAddon` rounds cells and
   leaves a border — accept the 1–3 px border, don't fight subpixel.
10. **Antivirus + SQLite.** Write the `.db` with WAL enabled
    (`PRAGMA journal_mode=WAL`) to reduce locks with file scanners.
11. **One instance only.** `single-instance` from F0 on — two instances
    writing `app.db` and `.bin` is guaranteed corruption. (Deliberate
    exception: `YARD_DATA_DIR` turns the lock off for development builds
    with their own data directory.)
12. **`chrome.exe --version` opens the browser.** On Windows the Chromium GUI
    binaries (and `msedge.exe`) ignore the flag: instead of printing the
    version and exiting, they bring up a real window. Probing the version
    that way made Edge and Chrome flash on the user's screen on every
    `cargo test` and every startup. The version comes from disk: the sibling
    folder carrying the number (`…\Application\151.0.…\`) for the Chromium
    browsers, `application.ini` for Firefox — see
    `browsers.rs::version_from_disk`. **Nothing in production launches an
    external browser**; a page on screen is always a WebView2 portal inside
    the Yard window.
