const { app, BrowserWindow, Tray, Menu, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

let mainWindow = null;
let streamlitProcess = null;
let tray = null;
const STREAMLIT_PORT = 8501;

// Check if port is available
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, '127.0.0.1');
  });
}

// Wait for Streamlit to be ready
function waitForStreamlit(maxRetries = 30, retryDelay = 1000) {
  return new Promise((resolve, reject) => {
    let retries = 0;
    const checkServer = () => {
      const client = net.createConnection({ port: STREAMLIT_PORT, host: '127.0.0.1' }, () => {
        client.end();
        console.log('Streamlit is ready!');
        resolve();
      });
      
      client.on('error', () => {
        retries++;
        if (retries < maxRetries) {
          console.log(`Waiting for Streamlit... (${retries}/${maxRetries})`);
          setTimeout(checkServer, retryDelay);
        } else {
          reject(new Error('Streamlit failed to start within timeout'));
        }
      });
    };
    checkServer();
  });
}

// Find Python executable
function findPython() {
  // Check if running from packaged app
  const isPackaged = app.isPackaged;
  const basePath = isPackaged 
    ? path.join(process.resourcesPath, 'LLM')
    : path.join(__dirname, '..', 'LLM');
  
  // Try venv first
  const venvPaths = [
    path.join(basePath, '.venv', 'Scripts', 'python.exe'),
    path.join(basePath, '.venv', 'bin', 'python'),
    path.join(basePath, 'venv', 'Scripts', 'python.exe'),
    path.join(basePath, 'venv', 'bin', 'python')
  ];
  
  for (const pythonPath of venvPaths) {
    if (fs.existsSync(pythonPath)) {
      console.log(`Found Python at: ${pythonPath}`);
      return pythonPath;
    }
  }
  
  // Fall back to system Python
  console.log('Using system Python');
  return process.platform === 'win32' ? 'python' : 'python3';
}

// Start Streamlit server
async function startStreamlit() {
  // Check if port is already in use
  const portAvailable = await isPortAvailable(STREAMLIT_PORT);
  if (!portAvailable) {
    console.log(`Port ${STREAMLIT_PORT} is already in use. Assuming Streamlit is already running.`);
    return;
  }
  
  const pythonPath = findPython();
  const isPackaged = app.isPackaged;
  const guiPath = isPackaged
    ? path.join(process.resourcesPath, 'LLM', 'gui.py')
    : path.join(__dirname, '..', 'LLM', 'gui.py');
  
  if (!fs.existsSync(guiPath)) {
    throw new Error(`GUI file not found at: ${guiPath}`);
  }
  
  console.log(`Starting Streamlit: ${pythonPath} -m streamlit run ${guiPath}`);
  
  streamlitProcess = spawn(pythonPath, [
    '-m', 'streamlit', 'run', guiPath,
    '--server.port', String(STREAMLIT_PORT),
    '--server.headless', 'true',
    '--browser.gatherUsageStats', 'false',
    '--server.address', '127.0.0.1'
  ], {
    env: { ...process.env, ELECTRON_MODE: '1' },
    cwd: path.dirname(guiPath),
    windowsHide: true
  });
  
  streamlitProcess.stdout.on('data', (data) => {
    console.log(`[Streamlit] ${data}`);
  });
  
  streamlitProcess.stderr.on('data', (data) => {
    console.error(`[Streamlit Error] ${data}`);
  });
  
  streamlitProcess.on('error', (error) => {
    console.error('Failed to start Streamlit:', error);
    dialog.showErrorBox('Streamlit Error', `Failed to start Streamlit: ${error.message}`);
  });
  
  streamlitProcess.on('close', (code) => {
    console.log(`Streamlit process exited with code ${code}`);
    if (code !== 0 && code !== null) {
      dialog.showErrorBox('Streamlit Crashed', `Streamlit process exited with code ${code}`);
    }
  });
}

// Create main window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    title: 'LLM Fine-tuning Studio',
    backgroundColor: '#1e1e1e',
    show: false // Don't show until ready
  });
  
  // Show window when ready to avoid flickering
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
  
  // Load Streamlit UI
  mainWindow.loadURL(`http://127.0.0.1:${STREAMLIT_PORT}`);
  
  // Handle window close - minimize to tray instead
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  
  // DevTools disabled - uncomment below to enable for debugging
  // if (!app.isPackaged) {
  //   mainWindow.webContents.openDevTools();
  // }
}

// Create system tray
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 
    process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  );
  
  // Create a simple tray icon if file doesn't exist
  if (!fs.existsSync(iconPath)) {
    console.warn('Tray icon not found, skipping tray creation');
    return;
  }
  
  tray = new Tray(iconPath);
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show App',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
        }
      }
    },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);
  
  tray.setToolTip('LLM Fine-tuning Studio');
  tray.setContextMenu(contextMenu);
  
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
    }
  });
}

// Cleanup on exit
function cleanup() {
  console.log('Cleaning up...');
  if (streamlitProcess) {
    console.log('Killing Streamlit process...');
    streamlitProcess.kill();
  }
}

// App lifecycle
app.on('ready', async () => {
  try {
    console.log('App is ready, starting Streamlit...');
    await startStreamlit();
    
    console.log('Waiting for Streamlit to be ready...');
    await waitForStreamlit();
    
    console.log('Creating main window...');
    createWindow();
    createTray();
  } catch (error) {
    console.error('Failed to start application:', error);
    dialog.showErrorBox('Startup Error', `Failed to start application: ${error.message}`);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // Don't quit on window close - keep running in tray
  if (process.platform !== 'darwin') {
    // On macOS, keep app running even with no windows
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('will-quit', cleanup);
app.on('quit', cleanup);

// Handle crashes gracefully
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  cleanup();
});

