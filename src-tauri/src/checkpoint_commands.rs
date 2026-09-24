//! Blocking checkpoint IO is serialized so reads never observe a partial restore.
use crate::checkpoints::{self, Checkpoint, Comparison, Preview};
use parking_lot::Mutex;
use std::path::PathBuf;

static ACCESS: Mutex<()> = Mutex::new(());

async fn run<T: Send + 'static>(
    work: impl FnOnce(PathBuf) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = ACCESS.lock();
        work(crate::paths::app_dir().join("checkpoints"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn checkpoint_create(
    root: String,
    task_id: String,
    task_label: String,
    label: String,
) -> Result<Checkpoint, String> {
    run(move |store| {
        checkpoints::create(
            &store,
            &PathBuf::from(root),
            &task_id,
            &task_label,
            &label,
            chrono::Utc::now().timestamp_millis(),
        )
    })
    .await
}

#[tauri::command]
pub async fn checkpoint_list(root: String) -> Result<Vec<Checkpoint>, String> {
    run(move |store| checkpoints::list(&store, &PathBuf::from(root))).await
}

#[tauri::command]
pub async fn checkpoint_preview(root: String, id: String) -> Result<Preview, String> {
    run(move |store| checkpoints::preview(&store, &PathBuf::from(root), &id)).await
}

#[tauri::command]
pub async fn checkpoint_compare(
    root: String,
    id: String,
    path: String,
) -> Result<Comparison, String> {
    run(move |store| checkpoints::compare_file(&store, &PathBuf::from(root), &id, &path)).await
}

#[tauri::command]
pub async fn checkpoint_restore(
    root: String,
    id: String,
    token: String,
) -> Result<Checkpoint, String> {
    run(move |store| {
        checkpoints::restore(
            &store,
            &PathBuf::from(root),
            &id,
            &token,
            chrono::Utc::now().timestamp_millis(),
        )
    })
    .await
}

#[tauri::command]
pub async fn checkpoint_delete(root: String, id: String) -> Result<(), String> {
    run(move |store| checkpoints::delete(&store, &PathBuf::from(root), &id)).await
}
