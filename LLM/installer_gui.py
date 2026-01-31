#!/usr/bin/env python3
"""
Independent Installation GUI for LLM Fine-tuning Studio
Uses tkinter (no dependencies required) to install and repair all components
"""

import sys
import os
import subprocess
import threading
import platform
from pathlib import Path
from tkinter import (
    Tk, ttk, Frame, Label, Button, Text, Scrollbar, Checkbutton, 
    StringVar, BooleanVar, messagebox
)
from typing import Optional, Tuple

# ============================================================================
# ACTIVE ENV RESOLUTION (env_key /.envs) - used by GUI for launch/checklist
# ============================================================================
def _derive_env_key_from_package_versions(package_versions: dict) -> str:
    """
    Align with EnvKeyResolver format: tf-<accelerator>-t<mm>-base-stable
    """
    from core.envs.env_key_resolver import encode_torch_mm

    torch_spec = str((package_versions or {}).get("torch", "")).strip()
    accelerator = "cpu"
    if "+cu" in torch_spec:
        cuda_part = torch_spec.split("+cu", 1)[1]
        digits = "".join([c for c in cuda_part if c.isdigit()])[:3]
        if digits:
            accelerator = f"cu{digits}"

    torch_mm = ""
    if torch_spec:
        base = torch_spec.split("+", 1)[0]
        parts = base.split(".")
        if len(parts) >= 2:
            torch_mm = f"{parts[0]}.{parts[1]}"
    t_enc = encode_torch_mm(torch_mm) if torch_mm else ""
    if t_enc:
        return f"tf-{accelerator}-t{t_enc}-base-stable"
    return f"tf-{accelerator}-base-stable"


def _get_active_env_python() -> tuple[str | None, str | None]:
    """
    Returns (python_exe_path, env_key) for the active hardware profile environment.
    Falls back to legacy LLM/.venv if env_key resolution fails.
    """
    llm_dir = Path(__file__).parent
    try:
        from system_detector import SystemDetector
        from core.profile_selector import ProfileSelector
        from setup_state import SetupStateManager

        setup_state = SetupStateManager()
        selected_gpu_index = setup_state.get_selected_gpu_index()
        override_profile = setup_state.get_selected_profile()

        detector = SystemDetector()
        hw_profile = detector.get_hardware_profile(selected_gpu_index=selected_gpu_index)

        matrix_path = llm_dir / "metadata" / "compatibility_matrix.json"
        selector = ProfileSelector(matrix_path)
        _profile_name, package_versions, _warnings, _binary = selector.select_profile(
            hw_profile, override_profile_id=override_profile
        )

        env_key = _derive_env_key_from_package_versions(package_versions)
        env_dir = llm_dir / ".envs" / env_key
        venv_dir = env_dir / ".venv"
        if sys.platform == "win32":
            python_exe = venv_dir / "Scripts" / "python.exe"
            pythonw_exe = venv_dir / "Scripts" / "pythonw.exe"
            if pythonw_exe.exists():
                return str(pythonw_exe), env_key
            if python_exe.exists():
                return str(python_exe), env_key
        else:
            python_exe = venv_dir / "bin" / "python"
            if python_exe.exists():
                return str(python_exe), env_key
    except Exception:
        pass

    # Legacy fallback
    venv_dir = llm_dir / ".venv"
    if sys.platform == "win32":
        python_exe = venv_dir / "Scripts" / "pythonw.exe"
        if not python_exe.exists():
            python_exe = venv_dir / "Scripts" / "python.exe"
    else:
        python_exe = venv_dir / "bin" / "python"
    return (str(python_exe) if python_exe.exists() else None), None


def _format_bytes(num_bytes: Optional[float]) -> str:
    if num_bytes is None:
        return ""
    try:
        n = float(num_bytes)
    except Exception:
        return ""
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if n < 1024.0 or unit == "TB":
            if unit == "B":
                return f"{int(n)} {unit}"
            return f"{n:.2f} {unit}"
        n /= 1024.0
    return ""


# ============================================================================
# HARD BOOTSTRAP GUARD - MUST BE FIRST
# ============================================================================
def _ensure_bootstrap():
    r"""
    Hard guard: Ensure installer NEVER runs from target venv (LLM\.venv).
    If running from target venv, auto-relaunch from bootstrap\.venv.
    """
    current_exe = Path(sys.executable).resolve()
    current_exe_str = str(current_exe)
    
    # Check if running from a target venv (LLM/.venv OR LLM/.envs/<env_key>/.venv)
    current_exe_normalized = current_exe_str.replace('\\', '/').lower()
    if (
        '/llm/.venv/' in current_exe_normalized
        or '/llm/.envs/' in current_exe_normalized
        or '\\llm\\.venv\\' in current_exe_str.lower()
        or '\\llm\\.envs\\' in current_exe_str.lower()
    ):
        # CRITICAL: Running from target venv - must relaunch from bootstrap
        print("=" * 60, file=sys.stderr)
        print("CRITICAL: Installer launched from target venv:", file=sys.stderr)
        print(f"  {sys.executable}", file=sys.stderr)
        print("Relaunching from bootstrap...", file=sys.stderr)
        print("=" * 60, file=sys.stderr)
        
        # Locate project root (parent of LLM directory)
        llm_dir = Path(__file__).parent.resolve()
        if llm_dir.name == "LLM":
            project_root = llm_dir.parent
        else:
            project_root = llm_dir
        
        # Windows subprocess flags to prevent CMD window flashing
        bootstrap_flags = {}
        if sys.platform == 'win32':
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = subprocess.SW_HIDE
            bootstrap_flags = {
                'startupinfo': startupinfo,
                'creationflags': subprocess.CREATE_NO_WINDOW
            }
        
        bootstrap_venv = project_root / "bootstrap" / ".venv"
        bootstrap_python = bootstrap_venv / "Scripts" / "python.exe" if platform.system() == "Windows" else bootstrap_venv / "bin" / "python"
        
        # Ensure bootstrap venv exists
        if not bootstrap_venv.exists() or not bootstrap_python.exists():
            print("Creating bootstrap venv...", file=sys.stderr)
            bootstrap_venv.parent.mkdir(parents=True, exist_ok=True)
            
            # Find system Python
            system_python = None
            # Try py launcher first (Windows)
            if platform.system() == "Windows":
                for py_arg in ["-3.10", "-3"]:
                    try:
                        result = subprocess.run(
                            ["py", py_arg, "-c", "import sys; print(sys.executable)"],
                            capture_output=True,
                            text=True,
                            timeout=5,
                            **bootstrap_flags
                        )
                        if result.returncode == 0:
                            system_python = result.stdout.strip()
                            break
                    except Exception:
                        continue
            
            # Try direct python commands
            if not system_python:
                for py_cmd in ["python3.10", "python3", "python"]:
                    try:
                        result = subprocess.run(
                            [py_cmd, "-c", "import sys; print(sys.executable)"],
                            capture_output=True,
                            text=True,
                            timeout=5,
                            **bootstrap_flags
                        )
                        if result.returncode == 0:
                            system_python = result.stdout.strip()
                            break
                    except Exception:
                        continue
            
            if not system_python:
                print("ERROR: Cannot find system Python to create bootstrap venv!", file=sys.stderr)
                print("Please install Python 3.10+ and try again.", file=sys.stderr)
                sys.exit(1)
            
            # Create bootstrap venv
            try:
                subprocess.run(
                    [system_python, "-m", "venv", str(bootstrap_venv)],
                    check=True,
                    timeout=60,
                    **bootstrap_flags
                )
                print("Bootstrap venv created.", file=sys.stderr)
            except Exception as e:
                print(f"ERROR: Failed to create bootstrap venv: {e}", file=sys.stderr)
                sys.exit(1)
        
        # Install installer dependencies into bootstrap
        installer_reqs = llm_dir / "installer_requirements.txt"
        if installer_reqs.exists():
            print("Installing installer dependencies into bootstrap...", file=sys.stderr)
            try:
                # Upgrade pip first
                subprocess.run(
                    [str(bootstrap_python), "-m", "pip", "install", "-U", "pip"],
                    check=True,
                    timeout=300,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    **bootstrap_flags
                )
                # Install requirements
                subprocess.run(
                    [str(bootstrap_python), "-m", "pip", "install", "-r", str(installer_reqs)],
                    check=True,
                    timeout=600,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    **bootstrap_flags
                )
                print("Installer dependencies installed.", file=sys.stderr)
            except Exception as e:
                print(f"WARNING: Failed to install some dependencies: {e}", file=sys.stderr)
                print("Continuing anyway...", file=sys.stderr)
        
        # Relaunch from bootstrap
        installer_script = llm_dir / "installer_gui.py"
        print(f"Relaunching installer from bootstrap: {bootstrap_python}", file=sys.stderr)
        try:
            subprocess.Popen(
                [str(bootstrap_python), str(installer_script)],
                cwd=str(llm_dir),
                **bootstrap_flags
            )
        except Exception as e:
            print(f"ERROR: Failed to relaunch installer: {e}", file=sys.stderr)
            sys.exit(1)
        
        # Exit current process
        sys.exit(0)

# Execute bootstrap check immediately
_ensure_bootstrap()

# Add current directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

try:
    from system_detector import SystemDetector
    from smart_installer import SmartInstaller
    from core.python_runtime import PythonRuntimeManager
except ImportError as e:
    # If imports fail, show error and exit
    root = Tk()
    root.withdraw()
    messagebox.showerror(
        "Import Error",
        f"Failed to import required modules:\n{str(e)}\n\n"
        "Please ensure system_detector.py and smart_installer.py are in the same directory."
    )
    sys.exit(1)


class ChecklistThread(threading.Thread):
    """Background thread for generating installation checklist"""
    def __init__(self, installer, check_python, root, callback):
        super().__init__(daemon=True)
        self.installer = installer
        self.check_python = check_python
        self.root = root
        self.callback = callback
        self.checklist = None
        self.error = None
    
    def run(self):
        try:
            self.checklist = self.installer.get_installation_checklist(
                python_executable=self.check_python
            )
        except Exception as e:
            self.error = e
        finally:
            # Call callback on main thread using after() (thread-safe tkinter call)
            if self.callback:
                self.root.after(0, lambda: self.callback(self.checklist, self.error))


class InstallerGUI:
    def __init__(self, root):
        self.root = root
        self.root.title("LLM Fine-tuning Studio - Installation & Repair")
        self.root.geometry("1000x800")
        self.root.minsize(900, 700)
        self.root.resizable(True, True)
        
        # State
        self.installer = SmartInstaller()
        self.detector = SystemDetector()
        self.python_runtime_manager = PythonRuntimeManager(Path(__file__).parent)
        self.checklist_data = []
        self.checklist_items = {}  # Store checklist item data by component name
        self.install_thread = None
        self.checklist_thread = None
        self.installing = False
        self._root_destroyed = False
        
        # Windows subprocess flags to prevent CMD window flashing
        self.subprocess_flags = {}
        if sys.platform == 'win32':
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = subprocess.SW_HIDE
            self.subprocess_flags = {
                'startupinfo': startupinfo,
                'creationflags': subprocess.CREATE_NO_WINDOW
            }
        
        # Track if root is destroyed
        self.root.protocol("WM_DELETE_WINDOW", self._on_closing)
        
        # Run detection on startup
        self.detector.detect_all()
        self.installer.detection_results = self.detector.detection_results
        
        # Build UI
        self._build_ui()
        
        # Populate checklist
        self._populate_checklist()
    
    def _build_ui(self):
        """Build the user interface"""
        # Main container - use grid layout
        main_frame = Frame(self.root, padx=20, pady=20)
        main_frame.grid(row=0, column=0, sticky="nsew")
        
        # Configure root window grid weights
        self.root.grid_rowconfigure(0, weight=1)
        self.root.grid_columnconfigure(0, weight=1)
        
        # Configure main_frame grid weights
        main_frame.grid_rowconfigure(3, weight=1)  # Checklist row - can expand
        main_frame.grid_rowconfigure(6, weight=1)  # Log row - can expand
        main_frame.grid_rowconfigure(7, weight=0)  # Button row - fixed, always visible
        main_frame.grid_columnconfigure(0, weight=1)
        
        # Row 0: Title
        title = Label(
            main_frame,
            text="🔧 LLM Fine-tuning Studio - Installation & Repair",
            font=("Arial", 16, "bold")
        )
        title.grid(row=0, column=0, sticky="w", pady=(0, 10))
        
        # Row 1: System Detection Panel
        detection_frame = Frame(main_frame, relief="ridge", borderwidth=2, padx=10, pady=10)
        detection_frame.grid(row=1, column=0, sticky="ew", pady=(0, 10))
        detection_frame.grid_columnconfigure(0, weight=1)
        
        Label(detection_frame, text="System Detection", font=("Arial", 12, "bold")).grid(row=0, column=0, sticky="w")
        
        self.detection_text = Text(detection_frame, height=6, wrap="word", state="disabled")
        self.detection_text.grid(row=1, column=0, sticky="ew", pady=(5, 0))
        self._update_detection_info()
        
        # Row 2: Installation Checklist Label with loading indicator
        checklist_header_frame = Frame(main_frame)
        checklist_header_frame.grid(row=2, column=0, sticky="ew", pady=(0, 5))
        checklist_header_frame.grid_columnconfigure(0, weight=1)
        
        checklist_label = Label(checklist_header_frame, text="Installation Checklist", font=("Arial", 12, "bold"))
        checklist_label.grid(row=0, column=0, sticky="w")
        
        # Loading indicator (initially hidden)
        self.checklist_loading_label = Label(
            checklist_header_frame, 
            text="⏳ Loading checklist...", 
            font=("Arial", 10), 
            fg="blue"
        )
        self.checklist_loading_label.grid(row=0, column=1, sticky="e", padx=(10, 0))
        self.checklist_loading_label.grid_remove()  # Hide initially
        
        # Row 3: Treeview for checklist (weight=1, can expand but height constrained)
        checklist_frame = Frame(main_frame)
        checklist_frame.grid(row=3, column=0, sticky="nsew", pady=(0, 10))
        checklist_frame.grid_rowconfigure(0, weight=1)
        checklist_frame.grid_columnconfigure(0, weight=1)
        
        # Scrollbar
        scrollbar = Scrollbar(checklist_frame)
        scrollbar.grid(row=0, column=1, sticky="ns")
        
        # Treeview - reduced height from 15 to 8
        self.checklist_tree = ttk.Treeview(
            checklist_frame,
            columns=("Version", "Status"),
            show="tree headings",
            yscrollcommand=scrollbar.set,
            height=8
        )
        scrollbar.config(command=self.checklist_tree.yview)
        
        # Configure columns
        self.checklist_tree.heading("#0", text="Component")
        self.checklist_tree.heading("Version", text="Version")
        self.checklist_tree.heading("Status", text="Status")
        self.checklist_tree.column("#0", width=300)
        self.checklist_tree.column("Version", width=200)
        self.checklist_tree.column("Status", width=200)
        
        # Configure tags for color coding
        self.checklist_tree.tag_configure("installed", foreground="green")
        self.checklist_tree.tag_configure("not_installed", foreground="red")
        self.checklist_tree.tag_configure("wrong_version", foreground="orange")
        self.checklist_tree.tag_configure("default", foreground="black")
        
        self.checklist_tree.grid(row=0, column=0, sticky="nsew")
        
        # Bind selection event to show package info
        self.checklist_tree.bind("<<TreeviewSelect>>", self._on_checklist_item_selected)
        
        # Row 4: Progress frame
        progress_frame = Frame(main_frame)
        progress_frame.grid(row=4, column=0, sticky="ew", pady=(0, 10))
        progress_frame.grid_columnconfigure(0, weight=1)
        
        Label(progress_frame, text="Progress:", font=("Arial", 10, "bold")).grid(row=0, column=0, sticky="w")

        # Overall progress (0-100)
        self.progress_var = StringVar(value="Ready")
        self.progress_label = Label(progress_frame, textvariable=self.progress_var, anchor="w")
        self.progress_label.grid(row=1, column=0, sticky="ew", pady=(5, 0))
        self.progress_bar = ttk.Progressbar(progress_frame, mode="determinate", maximum=100)
        self.progress_bar.grid(row=2, column=0, sticky="ew", pady=(5, 0))

        # Current download progress (0-100)
        self.download_var = StringVar(value="Download: idle")
        self.download_label = Label(progress_frame, textvariable=self.download_var, anchor="w")
        self.download_label.grid(row=3, column=0, sticky="ew", pady=(8, 0))
        self.download_bar = ttk.Progressbar(progress_frame, mode="determinate", maximum=100)
        self.download_bar.grid(row=4, column=0, sticky="ew", pady=(5, 0))
        
        # Row 5: Log label
        log_label = Label(main_frame, text="Installation Log:", font=("Arial", 10, "bold"))
        log_label.grid(row=5, column=0, sticky="w", pady=(0, 5))
        
        # Row 6: Log frame (weight=1, can expand but height constrained)
        log_frame = Frame(main_frame)
        log_frame.grid(row=6, column=0, sticky="nsew", pady=(0, 10))
        log_frame.grid_rowconfigure(0, weight=1)
        log_frame.grid_columnconfigure(0, weight=1)
        
        log_scrollbar = Scrollbar(log_frame)
        log_scrollbar.grid(row=0, column=1, sticky="ns")
        
        # Log text - increased height from 8 to 12
        self.log_text = Text(log_frame, wrap="word", yscrollcommand=log_scrollbar.set, height=12)
        log_scrollbar.config(command=self.log_text.yview)
        self.log_text.grid(row=0, column=0, sticky="nsew")
        
        # Row 7: Buttons (weight=0, fixed size, always visible)
        button_frame = Frame(main_frame)
        button_frame.grid(row=7, column=0, sticky="ew", pady=(10, 0))
        
        self.install_button = Button(
            button_frame,
            text="🛠️ Install/Repair All",
            command=self._start_installation,
            font=("Arial", 11, "bold"),
            bg="#4CAF50",
            fg="white",
            padx=20,
            pady=10,
            state="normal"
        )
        self.install_button.grid(row=0, column=0, padx=(0, 10))
        
        self.launch_button = Button(
            button_frame,
            text="🚀 Launch App",
            command=self._launch_app,
            font=("Arial", 11, "bold"),
            bg="#2196F3",
            fg="white",
            padx=20,
            pady=10,
            state="disabled"
        )
        self.launch_button.grid(row=0, column=1, padx=(0, 10))
        
        self.refresh_button = Button(
            button_frame,
            text="🔄 Refresh Status",
            command=self._refresh_status,
            font=("Arial", 11),
            padx=20,
            pady=10
        )
        self.refresh_button.grid(row=0, column=2)
    
    def _update_detection_info(self):
        """Update system detection information display"""
        results = self.detector.detection_results
        info_lines = []
        
        # Target app env (THIS is what we install/repair): env_key venv preferred
        target_python_str, env_key = _get_active_env_python()
        if env_key:
            info_lines.append(f"✓ Target env_key: {env_key}")
        if target_python_str:
            info_lines.append(f"✓ Target venv: {target_python_str}")
        else:
            info_lines.append("✗ Target venv Python missing (run Install/Repair)")
        
        # Python
        python_info = results.get("python", {})
        if python_info.get("found"):
            # This is the bootstrap Python running the installer UI
            info_lines.append(f"ℹ Installer Python {python_info.get('version', 'Unknown')} at {python_info.get('executable', 'Unknown')}")
        else:
            info_lines.append("✗ Python: Not found")
        
        # PyTorch
        pytorch_info = results.get("pytorch", {})
        if pytorch_info.get("found"):
            version = pytorch_info.get("version", "Unknown")
            cuda = " (CUDA)" if pytorch_info.get("cuda_available") else " (CPU)"
            info_lines.append(f"✓ PyTorch {version}{cuda}")
        else:
            info_lines.append("✗ PyTorch: Not installed")
        
        # CUDA
        cuda_info = results.get("cuda", {})
        if cuda_info.get("found"):
            gpus = cuda_info.get("gpus", [])
            info_lines.append(f"✓ CUDA {cuda_info.get('version', 'Unknown')} - {len(gpus)} GPU(s) detected")
        else:
            info_lines.append("ℹ CUDA: Not detected (CPU-only mode)")
        
        # Hardware
        hw_info = results.get("hardware", {})
        cpu = hw_info.get("cpu", "Unknown")
        ram = hw_info.get("ram_gb", 0)
        info_lines.append(f"💻 CPU: {cpu}, RAM: {ram:.1f} GB")
        
        self.detection_text.config(state="normal")
        self.detection_text.delete(1.0, "end")
        self.detection_text.insert(1.0, "\n".join(info_lines))
        self.detection_text.config(state="disabled")
    
    def _populate_checklist(self):
        """Populate the installation checklist asynchronously"""
        try:
            if self._root_destroyed:
                return
            
            # Clear existing items
            try:
                for item in self.checklist_tree.get_children():
                    self.checklist_tree.delete(item)
            except Exception as e:
                self._log(f"Error clearing checklist: {e}")
            
            # Show loading indicator
            try:
                self.checklist_loading_label.grid()
                # Note: ttk.Treeview doesn't support state="disabled", so we disable selection instead
                self.checklist_tree.config(selectmode="none")
                self.root.update_idletasks()
            except Exception as e:
                self._log(f"Error configuring checklist tree: {e}")
                import traceback
                self._log(traceback.format_exc())
            
            # Determine which Python to use for checking (env_key venv preferred)
            check_python, _env_key = _get_active_env_python()
            
            if not check_python:
                # Make it explicit in the UI log so it doesn't look like "everything is missing"
                self._log("WARNING: Target venv Python not found; checklist will reflect installer (bootstrap) environment.")
            
            # Start checklist generation in background thread
            self.checklist_thread = ChecklistThread(
                self.installer,
                check_python,
                self.root,
                self._on_checklist_ready
            )
            self.checklist_thread.start()
            
        except Exception as e:
            import traceback
            self._log(f"Error starting checklist generation: {str(e)}")
            self._log(f"Traceback: {traceback.format_exc()}")
            self.checklist_loading_label.grid_remove()
            self.checklist_tree.config(selectmode="browse")
    
    def _on_checklist_ready(self, checklist, error):
        """Callback when checklist generation completes"""
        try:
            if self._root_destroyed:
                return
            
            # Hide loading indicator
            try:
                self.checklist_loading_label.grid_remove()
                # Note: ttk.Treeview doesn't support state="normal", use selectmode="browse" instead
                self.checklist_tree.config(selectmode="browse")
            except Exception as e:
                self._log(f"Error re-enabling checklist tree: {e}")
                import traceback
                self._log(traceback.format_exc())
            
            if error:
                import traceback
                self._log(f"Error getting checklist: {str(error)}")
                self._log(f"Traceback: {traceback.format_exc()}")
                # Show error in checklist
                self.checklist_tree.insert("", "end", text="Error", values=("", "Failed to load checklist"))
                return
            
            if not checklist:
                self._log("Warning: Checklist is empty")
                return
            
            # Filter out triton-windows since it doesn't exist in wheelhouse and is optional
            checklist = [item for item in checklist if item.get("component") != "Triton (Windows)"]
            
            # Populate checklist tree
            for item in checklist:
                try:
                    component = item.get("component", "Unknown")
                    version = item.get("version", "N/A")
                    status = item.get("status", "unknown")
                    status_text = item.get("status_text", "? Unknown")
                    
                    # Determine tag based on status (check in order of specificity)
                    tag = "default"
                    if "✗" in status_text or "Not Installed" in status_text:
                        tag = "not_installed"
                    elif "✓" in status_text and "Installed" in status_text:
                        tag = "installed"
                    elif "⚠" in status_text or "Wrong Version" in status_text or "Wrong version" in status_text:
                        tag = "wrong_version"
                    elif "?" in status_text or "Cannot check" in status_text:
                        tag = "default"  # Keep default color for unknown status
                    
                    # Store item data for later retrieval
                    self.checklist_items[component] = item
                    
                    # Add to treeview with tag
                    item_id = self.checklist_tree.insert(
                        "",
                        "end",
                        text=component,
                        values=(version, status_text),
                        tags=(tag,)
                    )
                except Exception as e:
                    # Skip this item if there's an error
                    try:
                        print(f"Error adding checklist item: {e}")
                    except:
                        pass
        except Exception as e:
            try:
                import traceback
                self._log(f"Error populating checklist: {str(e)}")
                self._log(f"Traceback: {traceback.format_exc()}")
            except:
                try:
                    print(f"Error populating checklist: {e}")
                except:
                    pass
        finally:
            # Ensure loading indicator is hidden and tree is enabled
            try:
                if not self._root_destroyed:
                    self.checklist_loading_label.grid_remove()
                    # Note: ttk.Treeview doesn't support state="normal", use selectmode="browse" instead
                    self.checklist_tree.config(selectmode="browse")
            except Exception as e:
                # Silently fail - widget might be destroyed
                pass
    
    def _on_checklist_item_selected(self, event):
        """Handle checklist item selection - update info display"""
        try:
            selection = self.checklist_tree.selection()
            if not selection:
                return
            
            item_id = selection[0]
            component = self.checklist_tree.item(item_id, "text")
            
            # Get stored item data
            item_data = self.checklist_items.get(component)
            if not item_data:
                return
            
            # Build info text
            info_lines = []
            info_lines.append(f"📦 Package: {component}")
            info_lines.append("")
            
            version = item_data.get("version", "N/A")
            status_text = item_data.get("status_text", "? Unknown")
            status = item_data.get("status", "unknown")
            
            info_lines.append(f"Required Version: {version}")
            info_lines.append(f"Status: {status_text}")
            info_lines.append("")
            
            # Add any additional info from the item
            if "description" in item_data:
                info_lines.append(f"Description: {item_data['description']}")
                info_lines.append("")
            
            if "error" in item_data:
                info_lines.append(f"Error: {item_data['error']}")
                info_lines.append("")
            
            # Update detection text widget
            self.detection_text.config(state="normal")
            self.detection_text.delete(1.0, "end")
            self.detection_text.insert(1.0, "\n".join(info_lines))
            self.detection_text.config(state="disabled")
            
        except Exception as e:
            print(f"Error showing package info: {e}")
    
    
    def _safe_after(self, func, *args):
        """Safely schedule a function to run in the main thread"""
        try:
            if not self._root_destroyed:
                self.root.after(0, lambda: self._safe_call(func, *args))
        except:
            pass  # Root might be destroyed
    
    def _safe_call(self, func, *args):
        """Safely call a function with error handling"""
        try:
            if self._root_destroyed:
                return
            func(*args)
        except Exception as e:
            # Log to console if GUI logging fails
            try:
                print(f"GUI update error: {e}")
            except:
                pass
    
    def _on_closing(self):
        """Handle window closing"""
        self._root_destroyed = True
        if self.installing:
            import messagebox
            if messagebox.askokcancel("Quit", "Installation is in progress. Are you sure you want to quit?"):
                self.root.destroy()
        else:
            self.root.destroy()
    
    def _log(self, message):
        """Add message to log output"""
        try:
            if not self._root_destroyed:
                self.log_text.insert("end", message + "\n")
                self.log_text.see("end")
                self.root.update_idletasks()
        except:
            # Fallback to console if GUI fails
            try:
                print(f"[LOG] {message}")
            except:
                pass
    
    def _start_installation(self):
        """Start installation/repair process"""
        if self.installing:
            messagebox.showwarning("Already Installing", "Installation is already in progress.")
            return
        
        result = messagebox.askyesno(
            "Confirm Installation",
            "This will install/repair all required components.\n\n"
            "This may take several minutes. Continue?"
        )
        
        if not result:
            return
        
        self.installing = True
        self.install_button.config(state="disabled")
        self.launch_button.config(state="disabled")
        # Reset bars
        try:
            self.progress_bar["value"] = 0
            self.download_bar["value"] = 0
        except Exception:
            pass
        self.progress_var.set("Starting...")
        self.download_var.set("Download: idle")
        self.log_text.delete(1.0, "end")
        self._log("Starting installation/repair process...")
        
        # Run installation in background thread
        self.install_thread = threading.Thread(target=self._run_installation, daemon=True)
        self.install_thread.start()
    
    def _run_installation(self):
        """Run the actual installation (in background thread)"""
        # Write crash log file
        crash_log = Path(__file__).parent / "logs" / "installer_thread.log"
        crash_log.parent.mkdir(exist_ok=True)
        
        def write_log(msg):
            try:
                import datetime
                timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                with open(crash_log, "a", encoding="utf-8") as f:
                    f.write(f"[{timestamp}] {msg}\n")
                    f.flush()  # Force write immediately
            except Exception as e:
                try:
                    print(f"[CRASH_LOG_ERROR] {e}: {msg}")
                except:
                    pass
        
        try:
            write_log("=" * 60)
            write_log("Starting installation thread with InstallerV2")
            write_log("=" * 60)
            
            # Check for self-contained Python runtime
            write_log("Checking for self-contained Python runtime...")
            python_runtime = self.python_runtime_manager.get_python_runtime("3.12")
            if python_runtime:
                write_log(f"✓ Using self-contained Python: {python_runtime}")
            else:
                write_log("⚠ Self-contained Python not available, will use system Python")
            
            # Use new immutable installer
            from installer_v2 import InstallerV2
            
            installer_v2 = InstallerV2()
            
            # Redirect installer logs to GUI
            import builtins
            import io
            
            # Force UTF-8 encoding for stdout to handle Unicode symbols
            if sys.platform == 'win32':
                import codecs
                sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
                sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
            
            original_print = builtins.print
            
            def gui_print(*args, **kwargs):
                # Capture print output
                import io
                buffer = io.StringIO()
                kwargs_copy = kwargs.copy()
                kwargs_copy['file'] = buffer
                original_print(*args, **kwargs_copy)
                message = buffer.getvalue().rstrip()
                
                if message:
                    write_log(message)
                    self._safe_after(self._log, message)
                
                # Also print to original stdout
                original_print(*args, **kwargs)
            
            # Replace print temporarily
            builtins.print = gui_print
            
            try:
                # Check if venv exists to determine if we should repair or install
                # Always run repair: it will create the correct env_key env if missing,
                # and only install missing/broken packages if it already exists.
                write_log("Starting repair (auto-detect env_key; differential install)...")
                self._safe_after(self._log, "Starting repair (auto-detecting missing/broken packages)...")
                success = installer_v2.repair()
                write_log(f"InstallerV2.repair() returned: {success}")
            finally:
                # Restore original print
                builtins.print = original_print
            
            # Refresh checklist after installation
            self._safe_after(self._populate_checklist)
            
            if success:
                self._safe_after(self._log, "✓ Installation completed successfully!")
                self._safe_after(self.progress_var.set, "Installation Complete")
                self._safe_after(self.launch_button.config, {"state": "normal"})
                def show_success():
                    try:
                        messagebox.showinfo("Success", "Installation completed successfully!\n\nYou can now launch the application.")
                    except:
                        pass
                self._safe_after(show_success)
            else:
                self._safe_after(self._log, "✗ Installation completed with errors. Check log above.")
                self._safe_after(self.progress_var.set, "Installation Failed")
                def show_warning():
                    try:
                        messagebox.showerror("Installation Failed", "Installation failed. Please check the log for details.")
                    except:
                        pass
                self._safe_after(show_warning)
        
        except Exception as e:
            import traceback
            error_msg = str(e)
            error_trace = traceback.format_exc()
            write_log(f"EXCEPTION CAUGHT: {error_msg}")
            write_log(f"TRACEBACK:\n{error_trace}")
            try:
                self._safe_after(self._log, f"✗ Error during installation: {error_msg}")
                self._safe_after(self._log, f"Traceback:\n{error_trace}")
                self._safe_after(self.progress_var.set, f"Error: {error_msg}")
                def show_error():
                    try:
                        messagebox.showerror("Installation Error", f"An error occurred during installation:\n\n{error_msg}\n\nCheck the log for details.")
                    except:
                        pass
                self._safe_after(show_error)
            except Exception as e2:
                write_log(f"ERROR IN ERROR HANDLER: {e2}")
                print(f"CRITICAL: Error handler failed: {e2}")
                print(f"Original error: {error_msg}")
        
        finally:
            write_log("Entering finally block")
            try:
                if not self._root_destroyed:
                    write_log("Root not destroyed, cleaning up GUI...")
                    # determinate bars: ensure UI is responsive and re-enable buttons
                    self._safe_after(self.install_button.config, {"state": "normal"})
                    self.installing = False
                    self._safe_after(self._populate_checklist) # Refresh checklist one last time
                    write_log("GUI cleanup complete")
                else:
                    write_log("Root destroyed, skipping GUI cleanup")
            except Exception as e:
                write_log(f"ERROR IN FINALLY: {e}")
                try:
                    import traceback
                    write_log(traceback.format_exc())
                    print(f"Cleanup error in GUI: {e}")
                except:
                    pass
            write_log("Installation thread exiting")
    
    def _refresh_status(self):
        """Refresh the status of all components"""
        self._log("Refreshing status...")
        self.detector.detect_all()
        self.installer.detection_results = self.detector.detection_results
        self._update_detection_info()
        self._populate_checklist()
        self._log("Status refreshed.")
    
    def _launch_app(self):
        """Launch the main application"""
        try:
            import subprocess
            script_dir = Path(__file__).parent
            # Always launch using the ACTIVE env_key venv (not bootstrap)
            python_exe_str, _env_key = _get_active_env_python()
            if not python_exe_str:
                messagebox.showerror(
                    "Cannot Launch",
                    "Target virtual environment is missing or broken.\n\n"
                    "Please run Install/Repair first."
                )
                return
            
            # Launch main app
            # Windows subprocess flags to prevent CMD window flashing
            subprocess_kwargs = {}
            if sys.platform == 'win32':
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startupinfo.wShowWindow = subprocess.SW_HIDE
                subprocess_kwargs['startupinfo'] = startupinfo
                subprocess_kwargs['creationflags'] = subprocess.CREATE_NO_WINDOW
            
            subprocess.Popen(
                [python_exe_str, "-m", "desktop_app.main"],
                cwd=script_dir,
                **subprocess_kwargs
            )
            
            # Close installer GUI
            self.root.quit()
        
        except Exception as e:
            messagebox.showerror("Launch Error", f"Failed to launch application:\n\n{str(e)}")


def main():
    """Main entry point"""
    try:
        root = Tk()
        app = InstallerGUI(root)
        root.mainloop()
    except Exception as e:
        import traceback
        error_file = Path(__file__).parent / "logs" / "installer_crash.log"
        error_file.parent.mkdir(exist_ok=True)
        with open(error_file, "w", encoding="utf-8") as f:
            f.write(f"Installer GUI Crash\n")
            f.write(f"Error: {str(e)}\n")
            f.write(f"Traceback:\n{traceback.format_exc()}\n")
        print(f"CRASH: {e}")
        print(traceback.format_exc())
        try:
            # Show error dialog - this will block until user clicks OK
            messagebox.showerror("Fatal Error", f"The installer crashed.\n\nError: {str(e)}\n\nCheck logs/installer_crash.log for details.")
            # After dialog closes, exit gracefully instead of crashing
            sys.exit(1)
        except Exception as e2:
            # If showing dialog also fails, just exit
            print(f"Error showing dialog: {e2}")
            sys.exit(1)


if __name__ == "__main__":
    main()

