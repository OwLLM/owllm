// Preload script for Electron security
// This script runs in a separate context before the web page loads
// It can access both Electron APIs and the DOM, but is isolated from the main renderer process

const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electron', {
  // Future: Add any safe APIs you want to expose to Streamlit
  platform: process.platform,
  isElectron: true,
  
  // Example: Send messages to main process
  send: (channel, data) => {
    // Whitelist channels
    const validChannels = ['toMain'];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
  
  // Example: Receive messages from main process
  receive: (channel, func) => {
    const validChannels = ['fromMain'];
    if (validChannels.includes(channel)) {
      // Strip event as it includes sender
      ipcRenderer.on(channel, (event, ...args) => func(...args));
    }
  }
});

// Log that we're running in Electron mode
console.log('LLM Fine-tuning Studio - Running in Electron mode');

