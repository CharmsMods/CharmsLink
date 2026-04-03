const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopBridge', {
  isElectron: true,
  platform: process.platform,
  capabilities: {
    saveDialog: true,
    openDialog: true,
    fileWrites: true
  },
  async saveFile(options = {}) {
    const result = await ipcRenderer.invoke('desktop-save-file', {
      title: options.title,
      buttonLabel: options.buttonLabel,
      suggestedName: options.suggestedName,
      filters: options.filters,
      data: options.data instanceof Uint8Array
        ? options.data
        : new Uint8Array(options.data || [])
    });
    return result;
  },
  async showOpenDialog(options = {}) {
    return ipcRenderer.invoke('desktop-show-open-dialog', {
      title: options.title,
      buttonLabel: options.buttonLabel,
      defaultPath: options.defaultPath,
      filters: options.filters,
      multiple: !!options.multiple
    });
  }
});
