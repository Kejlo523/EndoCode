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

  function summarizeActionForMemory(action = {}) {
    if (!action || typeof action !== "object") return JSON.stringify(action || {});
    if (action.final) return JSON.stringify({ note: action.note || "", final: action.final });
    const tool = action.tool || "";
    const args = action.args || {};
    if (tool === "write_file") {
      return JSON.stringify({
        note: action.note || "",
        tool,
        args: {
          path: args.path || "",
          mode: args.mode || "overwrite",
          contentChars: String(args.content ?? "").length,
        },
      });
    }
    if (tool === "patch_edit") {
      return JSON.stringify({
        note: action.note || "",
        tool,
        args: {
          path: args.path || "",
          searchChars: String(args.search ?? "").length,
          replaceChars: String(args.replace ?? "").length,
          count: args.count ?? 1,
        },
      });
    }
    if (tool === "patch_batch") {
      const blocks = Array.isArray(args.blocks) ? args.blocks : [];
      return JSON.stringify({
        note: action.note || "",
        tool,
        args: {
          defaultPath: args.defaultPath || "",
          patchChars: String(args.patch ?? "").length,
          blocks: blocks.map((block) => ({
            path: block?.path || args.defaultPath || "",
            searchChars: String(block?.search ?? "").length,
            replaceChars: String(block?.replace ?? "").length,
          })),
        },
      });
    }
    return JSON.stringify(action);
  }

  function waitForRecoveryWindow(ms, signal) {
    const delay = Math.max(0, Number(ms) || 0);
    if (!delay) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      }, delay);
      const onAbort = () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(new Error("Przerwano przez uzytkownika."));
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
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
        const cooldownMs = Math.min(2800, 450 * Math.max(1, Number(planned.repeatCount) || 1));
        emit("status", {
          status: "action-cooldown",
          detail: `Wykryto petle akcji. Pauza ${Math.round(cooldownMs / 100) / 10}s i korekta planu...`,
          step,
        });
        await waitForRecoveryWindow(cooldownMs, signal);
        toolPayload = buildRepeatedActionBlock(action, planned.repeatCount);
      } else {
        emit("agent-phase", { phase: "execute", step, tool: action.tool || "" });
        toolPayload = await toolExecutor.run(action);
        if (toolPayload?.result?.url) sourceUrls.add(String(toolPayload.result.url));
      }
      if (!toolPayload?.ok && typeof onRecoverableError === "function") {
        emit("agent-phase", { phase: "recover", step, reason: "tool_error" });
        emit("status", {
          status: "action-cooldown",
          detail: "Krotka pauza recovery przed kolejna proba...",
          step,
        });
        await waitForRecoveryWindow(700, signal);
        await onRecoverableError({ step, action, toolPayload });
      } else {
        emit("agent-phase", { phase: "observe", step, tool: action.tool || "" });
      }
      memory.append("assistant", summarizeActionForMemory(action));
      memory.append("user", `Tool result:\n${JSON.stringify(toolPayload)}`);
    }
    return { ok: true, final: "Osiagnieto limit krokow. Napisz, zeby kontynuowac." };
  }

  return { runTurn };
}

module.exports = { createTurnOrchestrator };
