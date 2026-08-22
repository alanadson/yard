//! Window geometry across launches.
//!
//! Without this the window opens at the size in `tauri.conf.json` (1280x800)
//! on every boot, no matter what the user left behind. That is not only a
//! cosmetic annoyance: terminals marked `alive` auto-start during boot, and a
//! PTY is born with whatever the layout gives it *at that instant*. On a wide
//! monitor with the side panels open, 1280 px leaves `.workspace` pinned at its
//! 320 px minimum — about **31 columns**. An agent CLI paints its banner once,
//! from Ink's static output, and never redraws it: the box stays squeezed for
//! the whole session while everything printed after the user maximizes the
//! window is drawn wide. Restoring the real size is what makes the process born
//! at the width it will actually live at.
//!
//! Stored in `kv` under `window.geometry`, in **physical** pixels — the same
//! unit `set_size`/`set_position` take, so no DPI conversion can drift.

use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

use crate::persistence::db;
use crate::state::AppState;

const KEY: &str = "window.geometry";
/// Mirrors `minWidth`/`minHeight` in `tauri.conf.json`: a geometry saved by an
/// older build (or edited by hand in the kv table) must not open a window the
/// user cannot use.
const MIN_W: u32 = 900;
const MIN_H: u32 = 560;
/// A drag emits a `Resized` per mouse move. SQLite would survive it, but there
/// is no reason to write hundreds of times for one gesture — the close path
/// force-flushes, so nothing is lost by being lazy here.
const WRITE_EVERY: Duration = Duration::from_millis(600);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct Geometry {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    maximized: bool,
}

/// Latest geometry seen, waiting to be written.
static PENDING: Mutex<Option<Geometry>> = Mutex::new(None);
static LAST_WRITE: Mutex<Option<Instant>> = Mutex::new(None);

/// Applies the saved geometry. Called from `setup`, before the frontend has
/// painted anything — the window comes up already at the right size instead of
/// jumping, which is what keeps the boot-time spawns honest.
pub fn restore(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let raw = {
        let state = app.state::<Arc<AppState>>();
        let conn = state.db.lock();
        db::kv_get(&conn, KEY)
    };
    let Some(geo) = raw.and_then(|s| serde_json::from_str::<Geometry>(&s).ok()) else {
        // First launch (or a kv row we cannot read). Seed from the window the
        // config just created, so that someone who maximizes and never resizes
        // still gets a sane restore-down size next time instead of the floor.
        capture(&window);
        return;
    };

    let w = geo.w.max(MIN_W);
    let h = geo.h.max(MIN_H);
    if let Err(e) = window.set_size(PhysicalSize::new(w, h)) {
        tracing::warn!(error = %e, "nao consegui restaurar o tamanho da janela");
    }
    // A monitor that was there last time may be gone now. Restoring the
    // position blindly parks the window off-screen with no way to drag it back.
    if visible_on_some_monitor(&window, geo.x, geo.y, w, h) {
        if let Err(e) = window.set_position(PhysicalPosition::new(geo.x, geo.y)) {
            tracing::warn!(error = %e, "nao consegui restaurar a posicao da janela");
        }
    } else {
        tracing::info!(
            x = geo.x,
            y = geo.y,
            "posicao salva esta fora dos monitores; centralizando"
        );
        let _ = window.center();
    }
    if geo.maximized {
        let _ = window.maximize();
    }

    *PENDING.lock() = Some(Geometry {
        x: geo.x,
        y: geo.y,
        w,
        h,
        maximized: geo.maximized,
    });
    tracing::info!(
        w,
        h,
        maximized = geo.maximized,
        "geometria da janela restaurada"
    );
}

/// Starts following the window so the next boot has something to restore.
pub fn watch(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let handle = app.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
            if let Some(w) = handle.get_webview_window("main") {
                capture(&w);
            }
            flush(&handle, false);
        }
        // The last gesture is usually inside the throttle window; this is what
        // makes sure it still lands.
        WindowEvent::Destroyed | WindowEvent::CloseRequested { .. } => flush(&handle, true),
        _ => {}
    });
}

/// Writes whatever is pending, ignoring the throttle. For the exit path.
pub fn flush_now(app: &AppHandle) {
    flush(app, true);
}

fn capture(window: &WebviewWindow) {
    // A minimized window reports a garbage rect on Windows (position around
    // -32000). Saving it would restore a window nobody can find.
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let mut pending = PENDING.lock();
    let mut geo = pending.unwrap_or(Geometry {
        x: 0,
        y: 0,
        w: MIN_W,
        h: MIN_H,
        maximized,
    });
    geo.maximized = maximized;
    // While maximized the reported rect *is* the screen. Keeping it would mean
    // the restore-down size is lost the first time someone maximizes.
    if !maximized {
        if let Ok(size) = window.inner_size() {
            if size.width > 0 && size.height > 0 {
                geo.w = size.width;
                geo.h = size.height;
            }
        }
        if let Ok(pos) = window.outer_position() {
            geo.x = pos.x;
            geo.y = pos.y;
        }
    }
    *pending = Some(geo);
}

fn flush(app: &AppHandle, force: bool) {
    let geo = *PENDING.lock();
    let Some(geo) = geo else {
        return;
    };
    {
        let mut last = LAST_WRITE.lock();
        if !force {
            if let Some(t) = *last {
                if t.elapsed() < WRITE_EVERY {
                    return;
                }
            }
        }
        *last = Some(Instant::now());
    }
    let Ok(raw) = serde_json::to_string(&geo) else {
        return;
    };
    let state = app.state::<Arc<AppState>>();
    let conn = state.db.lock();
    if let Err(e) = db::kv_set(&conn, KEY, &raw) {
        tracing::warn!(error = %e, "nao consegui salvar a geometria da janela");
    }
}

/// Does the rect show up on any monitor currently attached?
fn visible_on_some_monitor(window: &WebviewWindow, x: i32, y: i32, w: u32, h: u32) -> bool {
    let Ok(monitors) = window.available_monitors() else {
        return false;
    };
    monitors.iter().any(|m| {
        let p = m.position();
        let s = m.size();
        overlaps((x, y, w, h), (p.x, p.y, s.width, s.height))
    })
}

/// Do two rects (x, y, w, h) share any pixel?
fn overlaps(a: (i32, i32, u32, u32), b: (i32, i32, u32, u32)) -> bool {
    let (ax, ay, aw, ah) = a;
    let (bx, by, bw, bh) = b;
    ax + aw as i32 > bx && ax < bx + bw as i32 && ay + ah as i32 > by && ay < by + bh as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geometry_survives_the_json_round_trip() {
        let geo = Geometry {
            x: -1920,
            y: 40,
            w: 2912,
            h: 1351,
            maximized: true,
        };
        let raw = serde_json::to_string(&geo).unwrap();
        assert_eq!(serde_json::from_str::<Geometry>(&raw).unwrap(), geo);
    }

    /// A kv row is text anyone can edit, and an old build may have written
    /// something else entirely. Garbage has to mean "no saved geometry", never
    /// a panic during `setup`.
    #[test]
    fn garbage_in_the_kv_does_not_bring_down_boot() {
        for raw in ["", "{}", "nao e json", r#"{"x":1}"#, "null", "[]"] {
            assert!(
                serde_json::from_str::<Geometry>(raw).is_err(),
                "accepted {raw:?} as geometry"
            );
        }
    }

    #[test]
    fn only_restores_a_position_that_still_fits_on_some_monitor() {
        let primary = (0, 0, 2560u32, 1440u32);
        let secondary = (-1920, 0, 1920u32, 1080u32);

        assert!(overlaps((100, 100, 1280, 800), primary));
        assert!(overlaps((-1800, 60, 1280, 800), secondary));
        // A sliver at the edge still counts: it can be dragged back.
        assert!(overlaps((2550, 100, 1280, 800), primary));
        // Secondary monitor disconnected: the saved position is no longer usable.
        assert!(!overlaps((-1800, 60, 1280, 800), primary));
        // Touching from outside, without a single pixel in common.
        assert!(!overlaps((2560, 100, 1280, 800), primary));
    }
}
