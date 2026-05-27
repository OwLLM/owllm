// Native folder / file pickers via the rfd crate. Win32-backed on
// Windows, GTK/Cocoa elsewhere. Kept as a separate module so the
// blocking calls happen in a spawn_blocking task and don't stall the
// Tauri async runtime.
//
// Returns Some(path) when the user picks something, None when they
// cancel. The Tauri command surface uses `Result<Option<String>, …>`
// so the React side can `await invoke<string | null>(…)`.

#[tauri::command]
pub async fn pick_folder(title: Option<String>) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new();
        if let Some(t) = title.as_deref() {
            dialog = dialog.set_title(t);
        }
        let picked = dialog.pick_folder();
        picked.map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("dialog task join: {e}"))
    .map(Ok)?
}

#[tauri::command]
pub async fn pick_file(
    title: Option<String>,
    filters: Option<Vec<(String, Vec<String>)>>,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new();
        if let Some(t) = title.as_deref() {
            dialog = dialog.set_title(t);
        }
        if let Some(fs) = filters.as_ref() {
            for (label, exts) in fs {
                let exts_str: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
                dialog = dialog.add_filter(label, &exts_str);
            }
        }
        let picked = dialog.pick_file();
        picked.map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("dialog task join: {e}"))
    .map(Ok)?
}
