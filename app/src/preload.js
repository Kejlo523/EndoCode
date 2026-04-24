const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("endocode", {
  getState: () => ipcRenderer.invoke("app:state"),
  selectWorkspace: () => ipcRenderer.invoke("app:select-workspace"),
  resetChat: () => ipcRenderer.invoke("app:reset-chat"),
  setModel: (modelId) => ipcRenderer.invoke("app:set-model", modelId),
  setReasoning: (level) => ipcRenderer.invoke("app:set-reasoning", level),
  send: (text) => ipcRenderer.invoke("agent:send", text),
  abort: () => ipcRenderer.invoke("agent:abort"),
  killServer: () => ipcRenderer.invoke("agent:kill-server"),
  approve: (approvalId, approved) => ipcRenderer.invoke("approval:reply", approvalId, approved),
  getSystemInfo: () => ipcRenderer.invoke("app:system-info"),
  getContextInfo: () => ipcRenderer.invoke("app:context-info"),
  setAccessLevel: (level) => ipcRenderer.invoke("app:set-access-level", level),
  saveChat: (session) => ipcRenderer.invoke("app:save-chat", session),
  loadChats: () => ipcRenderer.invoke("app:load-chats"),
  deleteChat: (chatId) => ipcRenderer.invoke("app:delete-chat", chatId),
  getModelSettings: () => ipcRenderer.invoke("app:get-model-settings"),
  setModelSettings: (settings) => ipcRenderer.invoke("app:set-model-settings", settings),
  resetModelSettings: () => ipcRenderer.invoke("app:reset-model-settings"),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
});
