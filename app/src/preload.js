const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bielik", {
  getState: () => ipcRenderer.invoke("app:state"),
  selectWorkspace: () => ipcRenderer.invoke("app:select-workspace"),
  resetChat: () => ipcRenderer.invoke("app:reset-chat"),
  setModel: (modelId) => ipcRenderer.invoke("app:set-model", modelId),
  setReasoning: (level) => ipcRenderer.invoke("app:set-reasoning", level),
  send: (text) => ipcRenderer.invoke("agent:send", text),
  abort: () => ipcRenderer.invoke("agent:abort"),
  approve: (approvalId, approved) => ipcRenderer.invoke("approval:reply", approvalId, approved),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
});
