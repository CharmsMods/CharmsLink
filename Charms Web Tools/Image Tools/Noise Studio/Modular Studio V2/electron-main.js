const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs/promises');
const path = require('path');

function sanitizeFileName(name, fallback = 'download') {
  return String(name || fallback)
    .trim()
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    || fallback;
}

function normalizeDialogFilters(filters = []) {
  if (!Array.isArray(filters)) return [];
  return filters
    .map((filter) => {
      const name = String(filter?.name || '').trim();
      const extensions = Array.isArray(filter?.extensions)
        ? filter.extensions
          .map((extension) => String(extension || '').trim().replace(/^\./, '').toLowerCase())
          .filter(Boolean)
        : [];
      if (!name || !extensions.length) return null;
      return { name, extensions };
    })
    .filter(Boolean);
}

ipcMain.handle('desktop-save-file', async (event, options = {}) => {
  const suggestedName = sanitizeFileName(options.suggestedName, 'download');
  const filters = normalizeDialogFilters(options.filters);
  const browserWindow = BrowserWindow.fromWebContents(event.sender) || undefined;
  const defaultPath = path.join(app.getPath('downloads'), suggestedName);
  const dialogResult = await dialog.showSaveDialog(browserWindow, {
    title: String(options.title || 'Save File'),
    defaultPath,
    buttonLabel: String(options.buttonLabel || 'Save'),
    filters: filters.length ? filters : undefined
  });

  if (dialogResult.canceled || !dialogResult.filePath) {
    return { status: 'cancelled' };
  }

  try {
    const bytes = options.data instanceof Uint8Array
      ? options.data
      : new Uint8Array(options.data || []);
    await fs.writeFile(dialogResult.filePath, Buffer.from(bytes));
    return {
      status: 'saved',
      source: 'desktop-bridge',
      filePath: dialogResult.filePath,
      fileName: path.basename(dialogResult.filePath)
    };
  } catch (error) {
    return {
      status: 'failed',
      source: 'desktop-bridge',
      error: error?.message || 'Could not save that file.'
    };
  }
});

ipcMain.handle('desktop-show-open-dialog', async (event, options = {}) => {
  const filters = normalizeDialogFilters(options.filters);
  const browserWindow = BrowserWindow.fromWebContents(event.sender) || undefined;
  const dialogResult = await dialog.showOpenDialog(browserWindow, {
    title: String(options.title || 'Open File'),
    buttonLabel: String(options.buttonLabel || 'Open'),
    defaultPath: options.defaultPath ? String(options.defaultPath) : undefined,
    filters: filters.length ? filters : undefined,
    properties: [
      'openFile',
      ...(options.multiple ? ['multiSelections'] : [])
    ]
  });

  if (dialogResult.canceled || !dialogResult.filePaths?.length) {
    return {
      status: 'cancelled',
      filePaths: []
    };
  }

  return {
    status: 'selected',
    filePaths: dialogResult.filePaths
  };
});

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Studio",
    icon: path.join(__dirname, 'ico.ico'),
    webPreferences: {
      nodeIntegration: false, // Standard practice for web apps in Electron
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Load the index.html of the app.
  mainWindow.loadFile('index.html');

  // Open the DevTools if needed (optional)
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
