function createTurnOrchestrator(options = {}) {
  const {
    planner,
    toolExecutor,
    memory,
    emit = () => {},
    compactMessages = () => {},
    appendSourcesSection = (text) => text,
    buildRepeatedActionBlock = () => ({ ok: false, error: "repeated-action" }),
  } = options;

  if (!planner || !toolExecutor || !memory) {
    throw new Error("createTurnOrchestrator requires planner, toolExecutor and memory");
  }

  async function runTurn(params = {}) {
    const {
      signal,
      userContent,
      maxSteps = 8,
      failedModelIds = new Set(),
    } = params;
    const sourceUrls = new Set();
    memory.beginTurn(userContent);
    memory.append("user", userContent);
    planner.reset();

    for (let step = 1; step <= maxSteps; step += 1) {
      if (signal?.aborted) throw new Error("Przerwano przez uzytkownika.");
      compactMessages();
      const planned = await planner.plan(signal, step, failedModelIds);
      const action = planned.action || {};
      if (action.note) emit("note", { note: action.note, step });

      if (action.final) {
        const finalText = appendSourcesSection(action.final, [...sourceUrls]);
        memory.append("assistant", finalText);
        return { ok: true, final: finalText };
      }

      let toolPayload;
      if (planned.repeated) {
        toolPayload = buildRepeatedActionBlock(action, planned.repeatCount);
      } else {
        toolPayload = await toolExecutor.run(action);
        if (toolPayload?.result?.url) sourceUrls.add(String(toolPayload.result.url));
      }
      memory.append("assistant", JSON.stringify(action));
      memory.append("user", `Tool result:\n${JSON.stringify(toolPayload)}`);
    }
    return { ok: true, final: "Osiagnieto limit krokow. Napisz, zeby kontynuowac." };
  }

  return { runTurn };
}

module.exports = { createTurnOrchestrator };
