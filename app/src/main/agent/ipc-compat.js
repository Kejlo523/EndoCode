function registerAgentIpcHandlers(ipcMain, handlers = {}) {
  const {
    runAgent,
    runSimpleChat,
    abortRun,
    killServer,
    approvalReply,
  } = handlers;

  ipcMain.handle("agent:send", (_event, payload) => runAgent(payload));
  ipcMain.handle("agent:chat", (_event, text) => runSimpleChat(text));
  ipcMain.handle("agent:abort", () => abortRun());
  ipcMain.handle("agent:kill-server", () => killServer());
  ipcMain.handle("approval:reply", (_event, approvalId, approved) => approvalReply(_event, approvalId, approved));
}

module.exports = { registerAgentIpcHandlers };
