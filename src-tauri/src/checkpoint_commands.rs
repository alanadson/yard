//! Blocking checkpoint IO is serialized so reads never observe a partial restore.
use crate::checkpoints::{self, Checkpoint, Comparison, Preview};
use parking_lot::Mutex;
use std::path::PathBuf;

static ACCESS: Mutex<()> = Mutex::new(());

pub(crate) fn serialized<T>(work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _guard = ACCESS.lock();
    work()
}

async fn run<T: Send + 'static>(
    work: impl FnOnce(PathBuf) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        serialized(|| work(crate::paths::app_dir().join("checkpoints")))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn checkpoint_create(
    state: tauri::State<'_, std::sync::Arc<crate::state::AppState>>,
    root: String,
    task_id: String,
    task_label: String,
    label: String,
) -> Result<Checkpoint, String> {
    let scope_root = root.clone();
    let scope_task = task_id.clone();
    let checkpoint = run(move |store| {
        checkpoints::create(
            &store,
            &PathBuf::from(root),
            &task_id,
            &task_label,
            &label,
            chrono::Utc::now().timestamp_millis(),
        )
    })
    .await?;
    let state = state.inner().clone();
    let saved = checkpoint.clone();
    tauri::async_runtime::spawn_blocking(move || crate::work::record_checkpoint_outcome(&mut state.db.lock(),
        &serde_json::json!({"id":saved.id,"taskId":scope_task}), &scope_root, Ok(Some(saved)), chrono::Utc::now().timestamp_millis()))
        .await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())?;
    Ok(checkpoint)
}

#[tauri::command]
#[specta::specta]
pub async fn checkpoint_list(root: String) -> Result<Vec<Checkpoint>, String> {
    run(move |store| checkpoints::list(&store, &PathBuf::from(root))).await
}

#[tauri::command]
#[specta::specta]
pub async fn checkpoint_preview(root: String, id: String) -> Result<Preview, String> {
    run(move |store| checkpoints::preview(&store, &PathBuf::from(root), &id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn checkpoint_compare(
    root: String,
    id: String,
    path: String,
) -> Result<Comparison, String> {
    run(move |store| checkpoints::compare_file(&store, &PathBuf::from(root), &id, &path)).await
}

#[tauri::command]
#[specta::specta]
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
#[specta::specta]
pub async fn checkpoint_delete(root: String, id: String) -> Result<(), String> {
    run(move |store| checkpoints::delete(&store, &PathBuf::from(root), &id)).await
}
