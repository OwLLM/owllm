use crate::EngineLogEvent;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::{sleep, Duration};

pub struct Supervisor {
    child: AsyncMutex<Option<Child>>,
}

impl Default for Supervisor {
    fn default() -> Self {
        Self {
            child: AsyncMutex::new(None),
        }
    }
}

impl Supervisor {
    fn desktop_root() -> PathBuf {
        if let Ok(p) = std::env::var("OWLLM_DESKTOP_ROOT") {
            return PathBuf::from(p);
        }

        if let Ok(exe) = std::env::current_exe() {
            for dir in exe.ancestors().filter(|p| p.is_dir()) {
                if dir.join("python_engine").join("owllm_engine").exists() {
                    return dir.to_path_buf();
                }
            }
        }

        // Development fallback: src-tauri/Cargo.toml -> apps/owllm-desktop
        let dev_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        dev_root.canonicalize().unwrap_or(dev_root)
    }

    fn python_exe() -> String {
        std::env::var("OWLLM_PYTHON").unwrap_or_else(|_| "python".to_string())
    }

    fn engine_module_path() -> PathBuf {
        Self::desktop_root().join("python_engine")
    }

    pub async fn ensure_running(&self) -> Result<(), String> {
        let ok = crate::engine_client::engine_get("/health").await.is_ok();
        if ok {
            return Ok(());
        }
        Err("engine is not reachable on /health (call engine_start)".to_string())
    }

    pub async fn ensure_or_start(&self, app: AppHandle) -> Result<(), String> {
        if self.ensure_running().await.is_ok() {
            return Ok(());
        }
        self.start(app).await?;
        self.wait_for_health(Duration::from_secs(20)).await
    }

    pub async fn wait_for_health(&self, timeout: Duration) -> Result<(), String> {
        let start = std::time::Instant::now();
        while start.elapsed() < timeout {
            if crate::engine_client::engine_get("/health").await.is_ok() {
                return Ok(());
            }
            sleep(Duration::from_millis(250)).await;
        }
        Err("engine did not become healthy before timeout".to_string())
    }

    pub async fn stop(&self) -> Result<(), String> {
        let mut guard = self.child.lock().await;
        if let Some(mut c) = guard.take() {
            let _ = c.kill().await;
        }
        Ok(())
    }

    pub async fn start(&self, app: AppHandle) -> Result<(), String> {
        // Restart if already running.
        self.stop().await?;

        let python = Self::python_exe();
        let engine_dir = Self::engine_module_path();

        let mut cmd = Command::new(python);
        cmd.kill_on_drop(true);
        cmd.current_dir(&engine_dir);
        cmd.env("PYTHONPATH", engine_dir.to_string_lossy().to_string());
        cmd.args(["-m", "owllm_engine"]);

        // Make stdout/stderr line-buffered as much as possible on Windows.
        cmd.stdin(std::process::Stdio::null());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| format!("failed to spawn python engine: {e}"))?;

        if let Some(stdout) = child.stdout.take() {
            let app2 = app.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = app2.emit(
                        "engine-log",
                        EngineLogEvent {
                            stream: "stdout".to_string(),
                            line,
                        },
                    );
                }
            });
        }

        if let Some(stderr) = child.stderr.take() {
            let app3 = app.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = app3.emit(
                        "engine-log",
                        EngineLogEvent {
                            stream: "stderr".to_string(),
                            line,
                        },
                    );
                }
            });
        }

        *self.child.lock().await = Some(child);
        self.wait_for_health(Duration::from_secs(20)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_root_points_at_apps_owllm_desktop() {
        let p = Supervisor::desktop_root();
        let s = p.to_string_lossy().to_lowercase();
        assert!(s.contains("owllm-desktop"));
        let pe = Supervisor::engine_module_path();
        assert!(pe.join("owllm_engine").exists());
    }
}
