function createTurnOrchestrator(options = {}) {
  const {
    planner,
    toolExecutor,
    memory,
    emit = () => {},
    compactMessages = () => {},
    appendSourcesSection = (text) => text,
    buildRepeatedActionBlock = () => ({ ok: false, error: "repeated-action" }),
    onRecoverableError = null,
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
      emit("agent-phase", { phase: "plan", step });
      compactMessages();
      const planned = await planner.plan(signal, step, failedModelIds);
      const action = planned.action || {};
      emit("agent-phase", { phase: "validate", step });
      if (action.note) emit("note", { note: action.note, step });

      if (action.final) {
        emit("agent-phase", { phase: "finalize", step });
        const finalText = appendSourcesSection(action.final, [...sourceUrls]);
        memory.append("assistant", finalText);
        return { ok: true, final: finalText };
      }

      let toolPayload;
      if (planned.repeated) {
        emit("agent-phase", { phase: "recover", step, reason: "repeated_action" });
        toolPayload = buildRepeatedActionBlock(action, planned.repeatCount);
      } else {
        emit("agent-phase", { phase: "execute", step, tool: action.tool || "" });
        toolPayload = await toolExecutor.run(action);
        if (toolPayload?.result?.url) sourceUrls.add(String(toolPayload.result.url));
      }
      if (!toolPayload?.ok && typeof onRecoverableError === "function") {
        emit("agent-phase", { phase: "recover", step, reason: "tool_error" });
        await onRecoverableError({ step, action, toolPayload });
      } else {
        emit("agent-phase", { phase: "observe", step, tool: action.tool || "" });
      }
      memory.append("assistant", JSON.stringify(action));
      memory.append("user", `Tool result:\n${JSON.stringify(toolPayload)}`);
    }
    return { ok: true, final: "Osiagnieto limit krokow. Napisz, zeby kontynuowac." };
  }

  return { runTurn };
}

module.exports = { createTurnOrchestrator };
