const { contextBridge, ipcRenderer } = require("electron/renderer");

contextBridge.exposeInMainWorld("appWindow", {
	openDiscord: () => ipcRenderer.send("open-discord"),
	openFAQ: () => ipcRenderer.send("open-faq"),
	openGitHub: () => ipcRenderer.send("open-github"),
	openDataFolder: () => ipcRenderer.send("open-data-folder"),
	openVoiceforge: () => ipcRenderer.send("open-voiceforge"),
	exportSaveAs: (jobId) => ipcRenderer.invoke("export-save-as", jobId),
	exportOpenFile: (jobId) => ipcRenderer.invoke("export-open-file", jobId),
	exportOpenFolder: (jobId) => ipcRenderer.invoke("export-open-folder", jobId),
});
