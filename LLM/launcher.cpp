#include <windows.h>
#include <string>
#include <vector>
#include <fstream>
#include <shlwapi.h>
#include <winreg.h>
#include <urlmon.h>

#pragma comment(lib, "shlwapi.lib")
#pragma comment(lib, "urlmon.lib")

// Helper to convert std::string to std::wstring
std::wstring StringToWString(const std::string& str) {
    if (str.empty()) return std::wstring();
    int size_needed = MultiByteToWideChar(CP_UTF8, 0, &str[0], (int)str.size(), NULL, 0);
    std::wstring wstrTo(size_needed, 0);
    MultiByteToWideChar(CP_UTF8, 0, &str[0], (int)str.size(), &wstrTo[0], size_needed);
    return wstrTo;
}

// Helper to convert std::wstring to std::string
std::string WStringToString(const std::wstring& wstr) {
    if (wstr.empty()) return std::string();
    int size_needed = WideCharToMultiByte(CP_UTF8, 0, &wstr[0], (int)wstr.size(), NULL, 0, NULL, NULL);
    std::string strTo(size_needed, 0);
    WideCharToMultiByte(CP_UTF8, 0, &wstr[0], (int)wstr.size(), &strTo[0], size_needed, NULL, NULL);
    return strTo;
}

// Helper to check if file exists
bool FileExists(const std::wstring& path) {
    DWORD attrib = GetFileAttributesW(path.c_str());
    return (attrib != INVALID_FILE_ATTRIBUTES && !(attrib & FILE_ATTRIBUTE_DIRECTORY));
}

// Helper to create logs directory
void EnsureLogsDirectory(const std::wstring& exeDir) {
    std::wstring logsDir = exeDir + L"\\logs";
    CreateDirectoryW(logsDir.c_str(), NULL);
}

// Helper to open log file in Notepad
void OpenLogInNotepad(const std::wstring& logPath) {
    ShellExecuteW(NULL, L"open", L"notepad.exe", logPath.c_str(), NULL, SW_SHOW);
}

// Preserve the selected Python executable.
std::wstring PreferConsolePythonForHiddenWorker(const std::wstring& pythonExe) {
    return pythonExe;
}

// Run a batch file with normal Windows console behavior.
bool RunBatchNoWindow(const std::wstring& batPath, const std::wstring& workingDir) {
    std::wstring cmd = L"cmd.exe /c \"" + batPath + L"\"";
    STARTUPINFOW si = {0};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi = {0};
    BOOL ok = CreateProcessW(NULL, &cmd[0], NULL, NULL, FALSE, 0,
        NULL, workingDir.c_str(), &si, &pi);
    if (ok) {
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
    }
    return !!ok;
}

// Helper to read cleanup request JSON
bool ReadCleanupRequest(const std::wstring& exeDir, std::wstring& modelDir) {
    std::wstring requestFile = exeDir + L"\\logs\\cleanup_request.json";
    if (!FileExists(requestFile)) {
        return false;
    }
    
    // Simple JSON parsing - look for "model_dir" field
    // Read entire file to handle multi-line JSON
    // Convert wstring to string for file operations
    std::string requestFileStr = WStringToString(requestFile);
    std::ifstream file(requestFileStr);
    if (!file.is_open()) {
        return false;
    }
    
    std::string content((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    file.close();
    
    // Look for "model_dir": "path" pattern (handles both single and multi-line)
    size_t pos = content.find("\"model_dir\"");
    if (pos != std::string::npos) {
        size_t colon = content.find(':', pos);
        if (colon != std::string::npos) {
            // Skip whitespace after colon
            size_t start = colon + 1;
            while (start < content.length() && (content[start] == ' ' || content[start] == '\t')) {
                start++;
            }
            
            if (start < content.length() && content[start] == '"') {
                size_t quote1 = start;
                size_t quote2 = content.find('"', quote1 + 1);
                if (quote2 != std::string::npos) {
                    std::string path = content.substr(quote1 + 1, quote2 - quote1 - 1);
                    // Convert to wide string
                    int size_needed = MultiByteToWideChar(CP_UTF8, 0, &path[0], (int)path.size(), NULL, 0);
                    if (size_needed > 0) {
                        modelDir.resize(size_needed);
                        MultiByteToWideChar(CP_UTF8, 0, &path[0], (int)path.size(), &modelDir[0], size_needed);
                        return true;
                    }
                }
            }
        }
    }
    
    return false;
}

// Helper to delete directory with retries (Windows)
bool DeleteDirectoryWithRetries(const std::wstring& dirPath, int maxAttempts = 5) {
    for (int attempt = 1; attempt <= maxAttempts; attempt++) {
        // Try cmd rmdir first
        std::wstring cmd = L"cmd /c rmdir /S /Q \"" + dirPath + L"\"";
        DWORD exitCode = 0;
        
        STARTUPINFOW si = {0};
        si.cb = sizeof(si);
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
        si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);

        PROCESS_INFORMATION pi = {0};
        BOOL success = CreateProcessW(
            NULL,
            &cmd[0],
            NULL,
            NULL,
            FALSE,
            0,
            NULL,
            NULL,
            &si,
            &pi
        );
        
        if (success) {
            WaitForSingleObject(pi.hProcess, 30000);  // 30 second timeout
            GetExitCodeProcess(pi.hProcess, &exitCode);
            CloseHandle(pi.hProcess);
            CloseHandle(pi.hThread);
        }
        
        // Check if directory still exists
        DWORD attrib = GetFileAttributesW(dirPath.c_str());
        if (attrib == INVALID_FILE_ATTRIBUTES || !(attrib & FILE_ATTRIBUTE_DIRECTORY)) {
            return true;  // Directory deleted
        }
        
        // If not last attempt, try PowerShell as fallback
        if (attempt >= 2) {
            std::wstring psCmd = L"powershell -Command \"Remove-Item -Path \\\"" + dirPath + L"\\\" -Recurse -Force -ErrorAction SilentlyContinue\"";
            STARTUPINFOW psi = {0};
            psi.cb = sizeof(psi);
            psi.dwFlags = STARTF_USESTDHANDLES;
            PROCESS_INFORMATION ppi = {0};
            if (CreateProcessW(NULL, &psCmd[0], NULL, NULL, FALSE, 0, NULL, NULL, &psi, &ppi)) {
                WaitForSingleObject(ppi.hProcess, 30000);
                CloseHandle(ppi.hProcess);
                CloseHandle(ppi.hThread);
            }
            
            attrib = GetFileAttributesW(dirPath.c_str());
            if (attrib == INVALID_FILE_ATTRIBUTES || !(attrib & FILE_ATTRIBUTE_DIRECTORY)) {
                return true;
            }
        }
        
        // Wait before retry
        if (attempt < maxAttempts) {
            Sleep(2000);  // 2 second delay
        }
    }
    
    return false;  // Failed after all attempts
}

// Helper to check for self-contained Python runtime
std::wstring CheckSelfContainedPython(const std::wstring& exeDir) {
    std::wstring selfContainedPython = exeDir + L"\\python_runtime\\python3.12\\python.exe";
    if (FileExists(selfContainedPython)) {
        return selfContainedPython;
    }
    return L"";
}

// Helper to get Python version string from executable
std::wstring GetPythonVersion(const std::wstring& pythonExe) {
    // Run python --version and capture output
    HANDLE hReadPipe, hWritePipe;
    SECURITY_ATTRIBUTES sa = {sizeof(SECURITY_ATTRIBUTES), NULL, TRUE};
    
    if (!CreatePipe(&hReadPipe, &hWritePipe, &sa, 0)) {
        return L"";
    }
    
    STARTUPINFOW si = {0};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdOutput = hWritePipe;
    si.hStdError = hWritePipe;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);

    PROCESS_INFORMATION pi = {0};
    std::wstring cmdLine = L"\"" + pythonExe + L"\" --version";

    BOOL success = CreateProcessW(
        NULL,
        &cmdLine[0],
        NULL,
        NULL,
        TRUE,
        0,
        NULL,
        NULL,
        &si,
        &pi
    );
    
    CloseHandle(hWritePipe);
    
    if (!success) {
        CloseHandle(hReadPipe);
        return L"";
    }
    
    // Read output
    char buffer[256] = {0};
    DWORD bytesRead = 0;
    ReadFile(hReadPipe, buffer, sizeof(buffer) - 1, &bytesRead, NULL);
    
    CloseHandle(hReadPipe);
    WaitForSingleObject(pi.hProcess, 5000);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    
    if (bytesRead > 0) {
        buffer[bytesRead] = 0;
        return StringToWString(std::string(buffer));
    }
    
    return L"";
}

// Helper to check if Python version is supported (3.10-3.12 only)
// Rejects ALL incompatible versions: too old (<3.10), too new (3.13+), or any future versions
bool IsPythonVersionSupported(const std::wstring& versionStr) {
    // Version string format: "Python 3.12.0", "Python 3.13.0", "Python 3.18.0", etc.
    // Extract major.minor version
    size_t spacePos = versionStr.find(L' ');
    if (spacePos == std::wstring::npos) return false;
    
    size_t dotPos = versionStr.find(L'.', spacePos + 1);
    if (dotPos == std::wstring::npos) return false;
    
    // Extract major version (should be 3)
    int major = _wtoi(versionStr.substr(spacePos + 1, 1).c_str());
    
    // Extract minor version (find next dot or space)
    size_t nextDot = versionStr.find(L'.', dotPos + 1);
    size_t nextSpace = versionStr.find(L' ', dotPos + 1);
    size_t endPos = versionStr.length();
    if (nextDot != std::wstring::npos && nextDot < endPos) endPos = nextDot;
    if (nextSpace != std::wstring::npos && nextSpace < endPos) endPos = nextSpace;
    
    int minor = _wtoi(versionStr.substr(dotPos + 1, endPos - dotPos - 1).c_str());
    
    // Support Python 3.10, 3.11, 3.12 only
    if (major == 3) {
        return (minor >= 10 && minor <= 12);
    }
    
    return false;
}

// Helper to run bootstrap launcher
bool RunBootstrapLauncher(const std::wstring& exeDir) {
    std::wstring bootstrapBat = exeDir + L"\\bootstrap_launcher.bat";
    if (!FileExists(bootstrapBat)) {
        return false;
    }
    
    // Run bootstrap launcher
    SHELLEXECUTEINFOW sei = {0};
    sei.cbSize = sizeof(sei);
    sei.fMask = SEE_MASK_NOCLOSEPROCESS;
    sei.lpFile = bootstrapBat.c_str();
    sei.lpDirectory = exeDir.c_str();
    sei.nShow = SW_SHOW;
    
    if (!ShellExecuteExW(&sei)) {
        return false;
    }
    
    // Wait for process to complete (max 5 minutes)
    if (sei.hProcess) {
        WaitForSingleObject(sei.hProcess, 300000);  // 5 minutes
        DWORD exitCode = 0;
        GetExitCodeProcess(sei.hProcess, &exitCode);
        CloseHandle(sei.hProcess);
        return (exitCode == 0);
    }
    
    return false;
}

// Helper to find Python in PATH or registry
std::wstring FindSystemPython() {
    // First, try to find python.exe in PATH
    wchar_t pythonPath[MAX_PATH];
    DWORD result = SearchPathW(NULL, L"python.exe", NULL, MAX_PATH, pythonPath, NULL);
    if (result > 0 && result < MAX_PATH) {
        return std::wstring(pythonPath);
    }
    
    // Try pythonw.exe in PATH
    result = SearchPathW(NULL, L"pythonw.exe", NULL, MAX_PATH, pythonPath, NULL);
    if (result > 0 && result < MAX_PATH) {
        return std::wstring(pythonPath);
    }
    
    // Check registry for Python installation
    HKEY hKey;
    // Check Python 3.x in registry (HKEY_LOCAL_MACHINE\SOFTWARE\Python\PythonCore\<version>\InstallPath)
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Python\\PythonCore", 0, KEY_READ, &hKey) == ERROR_SUCCESS) {
        DWORD index = 0;
        wchar_t versionKey[256];
        DWORD versionKeySize = sizeof(versionKey) / sizeof(wchar_t);
        
        while (RegEnumKeyExW(hKey, index, versionKey, &versionKeySize, NULL, NULL, NULL, NULL) == ERROR_SUCCESS) {
            std::wstring installPathKey = std::wstring(L"SOFTWARE\\Python\\PythonCore\\") + versionKey + L"\\InstallPath";
            HKEY hInstallKey;
            if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, installPathKey.c_str(), 0, KEY_READ, &hInstallKey) == ERROR_SUCCESS) {
                wchar_t installPath[MAX_PATH];
                DWORD pathSize = MAX_PATH * sizeof(wchar_t);
                DWORD type = REG_SZ;
                if (RegQueryValueExW(hInstallKey, L"ExecutablePath", NULL, &type, (LPBYTE)installPath, &pathSize) == ERROR_SUCCESS) {
                    if (FileExists(installPath)) {
                        RegCloseKey(hInstallKey);
                        RegCloseKey(hKey);
                        return std::wstring(installPath);
                    }
                }
                RegCloseKey(hInstallKey);
            }
            index++;
            versionKeySize = sizeof(versionKey) / sizeof(wchar_t);
        }
        RegCloseKey(hKey);
    }
    
    return L"";  // Not found
}

// Helper to download Python installer
bool DownloadPythonInstaller(const std::wstring& downloadPath) {
    // Download Python 3.10.x installer (64-bit) from python.org
    // Using embeddable package URL for smaller download, or full installer
    const wchar_t* pythonUrl = L"https://www.python.org/ftp/python/3.10.11/python-3.10.11-amd64.exe";
    
    // Use URLDownloadToFileW to download
    HRESULT hr = URLDownloadToFileW(NULL, pythonUrl, downloadPath.c_str(), 0, NULL);
    return (hr == S_OK);
}

// Helper to install Python silently
bool InstallPython(const std::wstring& installerPath) {
    // Run Python installer with /quiet and /PrependPath flags
    // /quiet = silent installation
    // /PrependPath = add Python to PATH
    std::wstring cmdLine = L"\"" + installerPath + L"\" /quiet PrependPath=1 InstallAllUsers=1";
    
    SHELLEXECUTEINFOW sei = {0};
    sei.cbSize = sizeof(sei);
    sei.fMask = SEE_MASK_NOCLOSEPROCESS;
    sei.lpVerb = L"runas";  // Run as administrator (may be needed)
    sei.lpFile = installerPath.c_str();
    sei.lpParameters = L"/quiet PrependPath=1 InstallAllUsers=1";
    sei.nShow = SW_SHOW;
    
    if (!ShellExecuteExW(&sei)) {
        // Try without runas if that fails
        sei.lpVerb = L"open";
        if (!ShellExecuteExW(&sei)) {
            return false;
        }
    }
    
    // Wait for installation to complete (max 5 minutes)
    if (sei.hProcess) {
        WaitForSingleObject(sei.hProcess, 300000);  // 5 minutes timeout
        DWORD exitCode = 0;
        GetExitCodeProcess(sei.hProcess, &exitCode);
        CloseHandle(sei.hProcess);
        return (exitCode == 0);
    }
    
    return false;
}

// Main launcher function
int LaunchPythonApp(const std::wstring& exeDir, const std::wstring& pythonExe,
                    const std::wstring& scriptArgs, const std::wstring& logFile,
                    bool hideConsole = false) {
    // Ensure logs directory exists before creating log file
    EnsureLogsDirectory(exeDir);

    // Build command line with normal Windows console behavior.
    std::wstring launchPython = PreferConsolePythonForHiddenWorker(pythonExe);
    std::wstring cmdLine = L"\"" + launchPython + L"\" " + scriptArgs;

    // Setup startup info with redirected output
    STARTUPINFOW si = {0};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    if (hideConsole) {
        si.dwFlags |= STARTF_USESHOWWINDOW;
        si.wShowWindow = SW_HIDE;
    }
    
    // Create log file for output
    SECURITY_ATTRIBUTES sa = {0};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;
    
    HANDLE hLogFile = CreateFileW(
        logFile.c_str(),
        GENERIC_WRITE,
        FILE_SHARE_READ,
        &sa,
        CREATE_ALWAYS,
        FILE_ATTRIBUTE_NORMAL,
        NULL
    );
    
    if (hLogFile != INVALID_HANDLE_VALUE) {
        si.hStdOutput = hLogFile;
        si.hStdError = hLogFile;
    } else {
        // Log file creation failed - write error to a fallback location
        std::wstring fallbackLog = exeDir + L"\\launcher_error.log";
        HANDLE hFallback = CreateFileW(
            fallbackLog.c_str(),
            GENERIC_WRITE,
            FILE_SHARE_READ,
            &sa,
            CREATE_ALWAYS,
            FILE_ATTRIBUTE_NORMAL,
            NULL
        );
        if (hFallback != INVALID_HANDLE_VALUE) {
            std::wstring errorMsg = L"Failed to create log file: " + logFile + L"\n";
            DWORD written = 0;
            WriteFile(hFallback, errorMsg.c_str(), errorMsg.length() * sizeof(wchar_t), &written, NULL);
            CloseHandle(hFallback);
        }
    }
    
    // Create the process
    PROCESS_INFORMATION pi = {0};
    DWORD creationFlags = hideConsole ? 0x08000000u /* hide console for brief health checks */ : 0u;
    BOOL success = CreateProcessW(
        launchPython.c_str(),       // Application name
        &cmdLine[0],                // Command line (must be writable)
        NULL,                       // Process security attributes
        NULL,                       // Thread security attributes
        TRUE,                       // Inherit handles (for log redirection)
        creationFlags,
        NULL,                       // Environment
        exeDir.c_str(),             // Working directory
        &si,                        // Startup info
        &pi                         // Process info
    );
    
    if (hLogFile != INVALID_HANDLE_VALUE) {
        CloseHandle(hLogFile);
    }
    
    if (!success) {
        return -1;
    }
    
    // Wait for process to complete
    WaitForSingleObject(pi.hProcess, INFINITE);
    
    // Get exit code
    DWORD exitCode = 0;
    GetExitCodeProcess(pi.hProcess, &exitCode);
    
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    
    return exitCode;
}

#if defined(LOCALLLM_LAUNCHER_WORKER) || defined(LOCALLLM_LAUNCHER_GUI)

// Full bootstrap + health checks + desktop app launch.
static int RunLauncherWorker() {
    // Get the directory where this .exe is located (LLM folder)
    wchar_t exePath[MAX_PATH];
    GetModuleFileNameW(NULL, exePath, MAX_PATH);

    // Extract directory path
    std::wstring exeDir(exePath);
    size_t lastSlash = exeDir.find_last_of(L"\\/");
    if (lastSlash != std::wstring::npos) {
        exeDir = exeDir.substr(0, lastSlash);
    }

    // Ensure logs directory exists
    EnsureLogsDirectory(exeDir);
    
    // Step 0: Check for self-contained Python runtime first (NEW)
    std::wstring selfContainedPython = CheckSelfContainedPython(exeDir);
    std::wstring systemPython;
    
    if (!selfContainedPython.empty()) {
        // Self-contained Python found - use it directly
        systemPython = selfContainedPython;
        goto use_python;  // Skip to venv check
    }
    
    // Step 1: Check if system Python exists and is compatible
    systemPython = FindSystemPython();
    
    if (!systemPython.empty()) {
        // Check Python version - reject ALL incompatible versions (too old, too new, or any future versions)
        std::wstring versionStr = GetPythonVersion(systemPython);
        if (!versionStr.empty() && !IsPythonVersionSupported(versionStr)) {
            // Python version incompatible (not 3.10-3.12) - use self-contained Python instead
            systemPython = L"";
        }
    }
    
    if (systemPython.empty()) {
        // No compatible system Python - try bootstrap launcher
        std::wstring bootstrapBat = exeDir + L"\\bootstrap_launcher.bat";
        if (FileExists(bootstrapBat)) {
            int result = MessageBoxW(NULL,
                L"Python 3.10-3.12 is required, but your system Python version is incompatible.\n\n"
                L"Would you like to download a self-contained Python runtime?\n"
                L"(This will not affect your system Python installation.)",
                L"Python Version Incompatible",
                MB_YESNO | MB_ICONQUESTION);
            
            if (result == IDYES) {
                MessageBoxW(NULL,
                    L"Downloading self-contained Python runtime...\n\n"
                    L"This may take a few minutes.\n"
                    L"Please wait...",
                    L"Downloading",
                    MB_OK | MB_ICONINFORMATION);
                
                if (RunBootstrapLauncher(exeDir)) {
                    // Check if self-contained Python is now available
                    selfContainedPython = CheckSelfContainedPython(exeDir);
                    if (!selfContainedPython.empty()) {
                        systemPython = selfContainedPython;
                        goto use_python;
                    }
                }
                
                MessageBoxW(NULL,
                    L"Failed to download self-contained Python runtime.\n\n"
                    L"Please try running bootstrap_launcher.bat manually.",
                    L"Download Failed",
                    MB_OK | MB_ICONERROR);
            }
        }
        
        // Fallback: Offer system Python installation (old behavior)
        int result = MessageBoxW(NULL,
            L"Python is not installed or has an incompatible version.\n\n"
            L"This application requires Python 3.10-3.12.\n\n"
            L"Would you like to download and install Python 3.12 system-wide?\n"
            L"(Alternatively, you can run bootstrap_launcher.bat for a self-contained installation.)",
            L"Python Required",
            MB_YESNO | MB_ICONQUESTION);
        
        if (result != IDYES) {
            MessageBoxW(NULL,
                L"Python installation is required.\n\n"
                L"Please install Python 3.10+ from https://www.python.org/downloads/\n"
                L"Make sure to check 'Add Python to PATH' during installation.",
                L"Python Required",
                MB_OK | MB_ICONINFORMATION);
            return 1;
        }
        
        // Download Python installer
        std::wstring tempDir = exeDir + L"\\temp";
        CreateDirectoryW(tempDir.c_str(), NULL);
        std::wstring installerPath = tempDir + L"\\python-installer.exe";
        
        MessageBoxW(NULL, L"Downloading Python installer...\n\nThis may take a few minutes.", L"Downloading", MB_OK | MB_ICONINFORMATION);
        
        if (!DownloadPythonInstaller(installerPath)) {
            MessageBoxW(NULL,
                L"Failed to download Python installer.\n\n"
                L"Please download and install Python 3.10+ manually from:\n"
                L"https://www.python.org/downloads/",
                L"Download Failed",
                MB_OK | MB_ICONERROR);
            return 1;
        }
        
        // Install Python
        MessageBoxW(NULL, L"Installing Python...\n\nThis may take a few minutes.\n\nPlease wait...", L"Installing", MB_OK | MB_ICONINFORMATION);
        
        if (!InstallPython(installerPath)) {
            MessageBoxW(NULL,
                L"Python installation failed or was cancelled.\n\n"
                L"Please install Python 3.10+ manually from:\n"
                L"https://www.python.org/downloads/",
                L"Installation Failed",
                MB_OK | MB_ICONERROR);
            return 1;
        }
        
        // Clean up installer
        DeleteFileW(installerPath.c_str());
        
        // Refresh PATH and try to find Python again
        // Note: PATH refresh may require restart, but we'll try anyway
        systemPython = FindSystemPython();
        if (systemPython.empty()) {
            MessageBoxW(NULL,
                L"Python was installed, but the launcher cannot find it.\n\n"
                L"Please restart your computer or manually add Python to PATH,\n"
                L"then run this launcher again.",
                L"Python Installed",
                MB_OK | MB_ICONINFORMATION);
            return 1;
        }
    }
    
    use_python:
    // Step 2: Check if venv exists and is complete, if not, launch installer GUI
    std::wstring pythonExe = exeDir + L"\\.venv\\Scripts\\python.exe";
    std::wstring pyvenvCfg = exeDir + L"\\.venv\\pyvenv.cfg";
    std::wstring venvPython = systemPython;  // Default to system Python

    // Use python.exe (console-attached) so child processes are visible.
    bool venvComplete = false;
    if (FileExists(pythonExe) && FileExists(pyvenvCfg)) {
        venvPython = pythonExe;
        venvComplete = true;
    }
    
    if (!venvComplete) {
        // Venv doesn't exist - launch installer GUI via bootstrap (no console window)
        std::wstring runInstallerBat = exeDir + L"\\run_installer.bat";
        if (FileExists(runInstallerBat)) {
            if (RunBatchNoWindow(runInstallerBat, exeDir))
                return 0;
        }
        std::wstring bootstrapBat = exeDir + L"\\bootstrap_launcher.bat";
        if (FileExists(bootstrapBat)) {
            if (RunBatchNoWindow(bootstrapBat, exeDir))
                return 0;
        }
        {
            // Fallback: installer_gui.py
            
            std::wstring installerGui = exeDir + L"\\installer_gui.py";
            if (FileExists(installerGui)) {
                // Use self-contained Python if available, otherwise system Python
                std::wstring pythonToUse = systemPython;
                if (pythonToUse.empty()) {
                    pythonToUse = CheckSelfContainedPython(exeDir);
                }
                if (pythonToUse.empty()) {
                    pythonToUse = FindSystemPython();
                }
                if (!pythonToUse.empty()) {
                    std::wstring guiPython = PreferConsolePythonForHiddenWorker(pythonToUse);
                    ShellExecuteW(NULL, L"open", guiPython.c_str(), installerGui.c_str(), exeDir.c_str(), SW_SHOW);
                    return 0;
                }
            } else {
                MessageBoxW(NULL,
                    L"Virtual environment not found and installer GUI not available.\n\n"
                    L"Please run the setup manually.",
                    L"Setup Required",
                    MB_OK | MB_ICONERROR);
                return 1;
            }
        }
    }
    
    // Ensure logs directory exists
    EnsureLogsDirectory(exeDir);
    
    // Step 3: Health check - Test if PySide6 can import
    // NOTE: All PySide6 packages MUST be at version 6.8.1 (PySide6, Essentials, Addons, shiboken6)
    // Version mismatches cause "procedure could not be found" DLL errors
    std::wstring healthCheckCmd = L"-c \"import PySide6.QtCore; print('OK')\"";
    std::wstring healthCheckLog = exeDir + L"\\logs\\health_check.log";
    
    int healthCheckResult = LaunchPythonApp(exeDir, venvPython, healthCheckCmd, healthCheckLog, /*hideConsole=*/true);
    
    if (healthCheckResult != 0) {
        // PySide6 is broken - launch installer GUI via bootstrap (no console window)
        std::wstring runInstallerBat = exeDir + L"\\run_installer.bat";
        if (FileExists(runInstallerBat) && RunBatchNoWindow(runInstallerBat, exeDir))
            return 0;
        std::wstring bootstrapBat = exeDir + L"\\bootstrap_launcher.bat";
        if (FileExists(bootstrapBat) && RunBatchNoWindow(bootstrapBat, exeDir))
            return 0;
        std::wstring installerGui = exeDir + L"\\installer_gui.py";
        if (FileExists(installerGui)) {
            std::wstring pythonToUse = systemPython;
            if (pythonToUse.empty())
                pythonToUse = CheckSelfContainedPython(exeDir);
            if (pythonToUse.empty())
                pythonToUse = FindSystemPython();
            if (!pythonToUse.empty()) {
                std::wstring guiPython = PreferConsolePythonForHiddenWorker(pythonToUse);
                ShellExecuteW(NULL, L"open", guiPython.c_str(), installerGui.c_str(), exeDir.c_str(), SW_SHOW);
                return 0;
            }
        }
        MessageBoxW(NULL,
            L"Critical dependencies are broken and installer GUI is not available.\n\n"
            L"Please run the setup manually or check the installation.",
            L"Setup Required",
            MB_OK | MB_ICONERROR);
        return 1;
    }
    
    // Step 4: Dependency health check - Verify critical packages are installed
    std::wstring dependencyCheckScript = exeDir + L"\\check_dependencies.py";
    std::wstring dependencyCheckLog = exeDir + L"\\logs\\dependency_check.log";
    
    if (FileExists(dependencyCheckScript)) {
        // Run check_dependencies.py as a script
        std::wstring dependencyCheckCmd = L"\"" + dependencyCheckScript + L"\"";
        int dependencyCheckResult = LaunchPythonApp(exeDir, venvPython, dependencyCheckCmd, dependencyCheckLog, /*hideConsole=*/true);
        
        if (dependencyCheckResult != 0) {
            // Dependencies are missing or wrong - launch installer GUI via bootstrap (no console window)
            std::wstring runInstallerBat = exeDir + L"\\run_installer.bat";
            if (FileExists(runInstallerBat) && RunBatchNoWindow(runInstallerBat, exeDir))
                return 0;
            std::wstring bootstrapBat = exeDir + L"\\bootstrap_launcher.bat";
            if (FileExists(bootstrapBat) && RunBatchNoWindow(bootstrapBat, exeDir))
                return 0;
            std::wstring installerGui = exeDir + L"\\installer_gui.py";
            if (FileExists(installerGui)) {
                std::wstring pythonToUse = systemPython;
                if (pythonToUse.empty())
                    pythonToUse = CheckSelfContainedPython(exeDir);
                if (pythonToUse.empty())
                    pythonToUse = FindSystemPython();
                if (!pythonToUse.empty()) {
                    std::wstring guiPython = PreferConsolePythonForHiddenWorker(pythonToUse);
                    ShellExecuteW(NULL, L"open", guiPython.c_str(), installerGui.c_str(), exeDir.c_str(), SW_SHOW);
                    return 0;
                }
            }
            MessageBoxW(NULL,
                L"Critical dependencies are missing or have wrong versions.\n\n"
                L"Installer GUI is not available.\n"
                L"Please run the setup manually or check the installation.",
                L"Setup Required",
                MB_OK | MB_ICONERROR);
            return 1;
        }
    } else {
        // Dependency check script missing - log warning but continue
        // (This shouldn't happen in normal operation, but don't block launch)
        std::wstring warnLog = exeDir + L"\\logs\\launcher_warning.log";
        std::ofstream warnFile(warnLog.c_str(), std::ios::app);
        if (warnFile.is_open()) {
            warnFile << "WARNING: check_dependencies.py not found, skipping dependency check\n";
            warnFile.close();
        }
    }
    
    // Step 5: Launch main application (PySide6 and dependencies are working)
    std::wstring scriptArgs = L"-m desktop_app.main";
    std::wstring logFile = exeDir + L"\\logs\\app.log";
    
    // Ensure .setup_complete marker exists so setup wizard is skipped
    std::wstring setupMarker = exeDir + L"\\.setup_complete";
    if (!FileExists(setupMarker)) {
        std::ofstream marker(setupMarker.c_str());
        if (marker.is_open()) {
            marker << "ready";
            marker.close();
        }
    }

    int exitCode = LaunchPythonApp(exeDir, venvPython, scriptArgs, logFile);
    
    // Handle cleanup-and-restart request (exit code 42)
    const int CLEANUP_AND_RESTART = 42;
    if (exitCode == CLEANUP_AND_RESTART) {
        // Read cleanup request
        std::wstring modelDir;
        if (ReadCleanupRequest(exeDir, modelDir)) {
            // Check for loop guard (prevent infinite restarts)
            std::wstring guardFile = exeDir + L"\\logs\\cleanup_guard.txt";
            std::string guardFileStr = WStringToString(guardFile);
            int restartCount = 0;
            
            // Read existing count
            std::ifstream guardIn(guardFileStr);
            if (guardIn.is_open()) {
                guardIn >> restartCount;
                guardIn.close();
            }
            
            const int MAX_RESTART_ATTEMPTS = 2;
            if (restartCount >= MAX_RESTART_ATTEMPTS) {
                // Too many restarts - show error
                std::wstring errorMsg = L"Model directory cleanup failed after " + 
                    std::to_wstring(MAX_RESTART_ATTEMPTS) + 
                    L" attempts.\n\n"
                    L"Directory: " + modelDir + L"\n\n"
                    L"Files may be locked by:\n"
                    L"- Antivirus software\n"
                    L"- Windows Search/Indexer\n"
                    L"- Another application\n\n"
                    L"Please close other applications and try again manually.";
                
                MessageBoxW(NULL, errorMsg.c_str(), L"Cleanup Failed", MB_OK | MB_ICONERROR);
                
                // Delete guard file
                DeleteFileW(guardFile.c_str());
                // Delete request file
                DeleteFileW((exeDir + L"\\logs\\cleanup_request.json").c_str());
                
                return 1;
            }
            
            // Increment restart count
            restartCount++;
            std::ofstream guardOut(guardFileStr);
            if (guardOut.is_open()) {
                guardOut << restartCount;
                guardOut.close();
            }
            
            // Attempt to delete model directory (only once, no retries in launcher)
            bool deleted = DeleteDirectoryWithRetries(modelDir, 3);
            
            // ALWAYS delete request file immediately to prevent loops
            DeleteFileW((exeDir + L"\\logs\\cleanup_request.json").c_str());
            
            if (deleted) {
                // Success - delete guard file and relaunch
                DeleteFileW(guardFile.c_str());
                
                // Small delay to ensure handles are released
                Sleep(1000);
                
                // Relaunch the app
                return LaunchPythonApp(exeDir, venvPython, scriptArgs, logFile);
            } else {
                // Deletion failed - STOP and show error (don't restart)
                std::wstring errorMsg = L"Could not delete model directory.\n\n"
                    L"Directory: " + modelDir + L"\n\n"
                    L"Files are locked by another process.\n\n"
                    L"Please:\n"
                    L"1. Close the app completely\n"
                    L"2. Close antivirus/Windows Search\n"
                    L"3. Manually delete: " + modelDir + L"\n"
                    L"4. Restart the app";
                
                MessageBoxW(NULL, errorMsg.c_str(), L"Cleanup Failed", MB_OK | MB_ICONERROR);
                
                // Clean up guard file
                DeleteFileW(guardFile.c_str());
                
                // Exit without restarting - break the loop
                return 1;
            }
        } else {
            // No cleanup request found - treat as normal error
            MessageBoxW(NULL, 
                L"Cleanup requested but cleanup_request.json not found.\n"
                L"Application will exit.",
                L"Cleanup Error", 
                MB_OK | MB_ICONWARNING);
            return 1;
        }
    }
    
    if (exitCode != 0) {
        // The app exited non-zero. Previously this auto-launched the
        // installer GUI on every non-zero exit, which is wrong: the dep
        // check + health check just passed, so a non-zero exit here is a
        // real app crash, not a missing dependency. Auto-launching the
        // installer turned ordinary crashes into "your install is broken,
        // run repair" — which is misleading and often the user's wrong
        // first move.
        //
        // The expected uses of non-zero exit are:
        //   42  -> cleanup-and-restart (already handled above)
        //   3   -> reserved for "deps drifted at runtime, please reinstall"
        //          (set by desktop_app.main when an ImportError-class
        //          failure happens during startup; the installer is the
        //          right answer in that one case).
        //   anything else -> real crash. Show the log, do NOT spawn the
        //          installer.
        const int DEPS_DRIFTED_AT_RUNTIME = 3;
        if (exitCode == DEPS_DRIFTED_AT_RUNTIME) {
            std::wstring runInstallerBat = exeDir + L"\\run_installer.bat";
            std::wstring bootstrapBat    = exeDir + L"\\bootstrap_launcher.bat";
            std::wstring installerGui    = exeDir + L"\\installer_gui.py";
            if (FileExists(runInstallerBat) && RunBatchNoWindow(runInstallerBat, exeDir))
                return 0;
            if (FileExists(bootstrapBat) && RunBatchNoWindow(bootstrapBat, exeDir))
                return 0;
            if (FileExists(installerGui)) {
                std::wstring pythonToUse = systemPython;
                if (pythonToUse.empty()) pythonToUse = CheckSelfContainedPython(exeDir);
                if (pythonToUse.empty()) pythonToUse = FindSystemPython();
                if (!pythonToUse.empty()) {
                    std::wstring guiPython = PreferConsolePythonForHiddenWorker(pythonToUse);
                    ShellExecuteW(NULL, L"open", guiPython.c_str(), installerGui.c_str(), exeDir.c_str(), SW_SHOW);
                    return 0;
                }
            }
        }

        // Generic crash: just open the log in Notepad and exit. Do NOT
        // spawn the installer — it is misleading when deps are fine.
        MessageBoxW(NULL,
                   L"Application exited unexpectedly.\n\n"
                   L"The most recent log will open in Notepad. Look at the "
                   L"end of it for the actual error.\n\n"
                   L"If you suspect a dependency is broken, run "
                   L"run_installer.bat manually.",
                   L"Application Error",
                   MB_OK | MB_ICONERROR);
        OpenLogInNotepad(logFile);
        return exitCode;
    }

    return exitCode;
}

#if defined(LOCALLLM_LAUNCHER_WORKER)
int main() {
    return RunLauncherWorker();
}

#elif defined(LOCALLLM_LAUNCHER_GUI)

// GUI-subsystem launcher: run the launcher flow directly. No launcher_worker.exe
// is started during normal app startup.
int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance,
                   LPSTR lpCmdLine, int nCmdShow) {
    (void)hInstance;
    (void)hPrevInstance;
    (void)lpCmdLine;
    (void)nCmdShow;
    return RunLauncherWorker();
}

#else
#error "Build launcher with -DLOCALLLM_LAUNCHER_GUI or -DLOCALLLM_LAUNCHER_WORKER"
#endif

#endif
