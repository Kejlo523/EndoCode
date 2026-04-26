const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("endocode", {
  getState: () => ipcRenderer.invoke("app:state"),
  selectWorkspace: () => ipcRenderer.invoke("app:select-workspace"),
  restoreWorkspace: (root) => ipcRenderer.invoke("app:restore-workspace", root),
  resetChat: () => ipcRenderer.invoke("app:reset-chat"),
  setModel: (modelId) => ipcRenderer.invoke("app:set-model", modelId),
  setReasoning: (level) => ipcRenderer.invoke("app:set-reasoning", level),
  send: (text) => ipcRenderer.invoke("agent:send", text),
  sendChat: (text) => ipcRenderer.invoke("agent:chat", text),
  abort: () => ipcRenderer.invoke("agent:abort"),
  killServer: () => ipcRenderer.invoke("agent:kill-server"),
  approve: (approvalId, approved) => ipcRenderer.invoke("approval:reply", approvalId, approved),
  getSystemInfo: () => ipcRenderer.invoke("app:system-info"),
  installRuntime: () => ipcRenderer.invoke("app:install-runtime"),
  getContextInfo: () => ipcRenderer.invoke("app:context-info"),
  setAccessLevel: (level) => ipcRenderer.invoke("app:set-access-level", level),
  saveChat: (session) => ipcRenderer.invoke("app:save-chat", session),
  loadChats: () => ipcRenderer.invoke("app:load-chats"),
  loadChatContext: (chatId) => ipcRenderer.invoke("app:load-chat-context", chatId),
  deleteChat: (chatId) => ipcRenderer.invoke("app:delete-chat", chatId),
  listSkills: () => ipcRenderer.invoke("app:list-skills"),
  installSkill: (skillId) => ipcRenderer.invoke("app:install-skill", skillId),
  uninstallSkill: (skillId) => ipcRenderer.invoke("app:uninstall-skill", skillId),
  installRecommendedSkills: () => ipcRenderer.invoke("app:install-recommended-skills"),
  getModelSettings: (modelId) => ipcRenderer.invoke("app:get-model-settings", modelId),
  setModelSettings: (payload) => ipcRenderer.invoke("app:set-model-settings", payload),
  resetModelSettings: (modelId) => ipcRenderer.invoke("app:reset-model-settings", modelId),
  getModelRawConfig: (modelId) => ipcRenderer.invoke("app:get-model-raw-config", modelId),
  setModelRawConfig: (payload) => ipcRenderer.invoke("app:set-model-raw-config", payload),
  listModels: () => ipcRenderer.invoke("app:list-models"),
  downloadModel: (modelId) => ipcRenderer.invoke("app:download-model", modelId),
  deleteModel: (modelId) => ipcRenderer.invoke("app:delete-model", modelId),
  addCustomModel: (urlOrPath) => ipcRenderer.invoke("app:add-custom-model", urlOrPath),
  searchModels: (options) => ipcRenderer.invoke("app:search-models", options),
  searchHfModels: (options) => ipcRenderer.invoke("app:search-hf-models", options),
  openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
});
