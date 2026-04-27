function createSessionMemory(options = {}) {
  const {
    maxTaskMessages = 8,
    summarize = (messages) => messages.slice(-2).map((m) => `${m.role}: ${String(m.content || "").slice(0, 180)}`).join("\n"),
    detectIntentKey = (text) => String(text || "").trim().toLowerCase().slice(0, 120),
    shouldResetOnIntentChange = () => false,
  } = options;

  let currentIntentKey = "";
  let taskMessages = [];
  let sessionSummary = "";

  function hardReset(nextIntentKey = "") {
    taskMessages = [];
    sessionSummary = "";
    currentIntentKey = String(nextIntentKey || "");
  }

  function beginTurn(userText) {
    const nextIntentKey = detectIntentKey(userText);
    if (!currentIntentKey) currentIntentKey = nextIntentKey;
    if (
      nextIntentKey
      && currentIntentKey
      && nextIntentKey !== currentIntentKey
      && shouldResetOnIntentChange(currentIntentKey, nextIntentKey, userText)
    ) {
      hardReset(nextIntentKey);
    }
    if (nextIntentKey && !currentIntentKey) currentIntentKey = nextIntentKey;
  }

  function append(role, content) {
    taskMessages.push({ role, content: String(content || "") });
    if (taskMessages.length > maxTaskMessages) {
      const overflow = taskMessages.splice(0, taskMessages.length - maxTaskMessages);
      const compact = summarize(overflow);
      if (compact) {
        sessionSummary = sessionSummary
          ? `${sessionSummary}\n${compact}`.slice(-2000)
          : compact.slice(-2000);
      }
    }
  }

  function getModelContext() {
    const blocks = [];
    if (sessionSummary) blocks.push({ role: "user", content: `Session summary:\n${sessionSummary}` });
    blocks.push(...taskMessages);
    return blocks;
  }

  function getState() {
    return {
      currentIntentKey,
      sessionSummary,
      taskMessages: taskMessages.slice(),
    };
  }

  return {
    beginTurn,
    append,
    hardReset,
    getModelContext,
    getState,
  };
}

module.exports = { createSessionMemory };
