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
    summarizeToolPayloadForMemory = (payload) => JSON.stringify(payload),
  } = options;

  if (!planner || !toolExecutor || !memory) {
    throw new Error("createTurnOrchestrator requires planner, toolExecutor and memory");
  }

  const errorCounts = new Map();

  function compact(value, max = 220) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
  }

  function pathFromAction(action = {}) {
    const args = action.args || {};
    if (args.path) return String(args.path);
    if (args.defaultPath) return String(args.defaultPath);
    if (Array.isArray(args.blocks) && args.blocks[0]?.path) return String(args.blocks[0].path);
    return "";
  }

  function errorClassFromPayload(payload = {}) {
    const text = `${payload?.errorCode || ""} ${payload?.error || ""}`;
    if (/SEARCH_REPLACE_NO_EXACT_MATCH/i.test(text)) return "search_replace_no_match";
    if (/PATH_COLLISION_DIRECTORY|EISDIR|To nie jest plik|path is directory|jest katalogiem/i.test(text)) return "path_directory_collision";
    if (/MKDIR_FILE_PATH_BLOCKED|mkdir_file_path|wyglada jak plik|wyglada jak sciezka pliku/i.test(text)) return "mkdir_file_path";
    if (/WHOLE_FILE_OVERWRITE|large_write_file/i.test(text)) return "large_write_file_blocked";
    if (/FULL_SITE_UNDERBUILT_ARTIFACT/i.test(text)) return "underbuilt_full_site_artifact";
    if (/EMPTY_SEARCH_EXISTING_FILE_BLOCKED/i.test(text)) return "empty_search_existing_file";
    if (/repeated|zablokowano zapetlenie|zapetlenie/i.test(text)) return "repeated_action";
    if (/ENOENT|nie znaleziono|not found/i.test(text)) return "path_missing";
    return "tool_error";
  }

  function errorLoopKey(action = {}, payload = {}) {
    return `${errorClassFromPayload(payload)}:${action.tool || ""}:${pathFromAction(action) || ""}`;
  }

  function buildEscalatedRecoveryInstruction(action = {}, payload = {}, count = 0) {
    const pathHint = pathFromAction(action);
    return [
      "RECOVERY_ESCALATION",
      `similar_error_count=${count}`,
      `tool=${action.tool || "unknown"}`,
      `path=${pathHint || "(brak)"}`,
      `error_class=${errorClassFromPayload(payload)}`,
      `error=${compact(payload?.error || "tool error", 360)}`,
      "Nie powtarzaj kolejnego duzego patcha ani tej samej akcji.",
      "Jesli ostatnie udane narzedzie to read_file/ls, nie czytaj tego samego miejsca ponownie.",
      "Wykonaj teraz jedno z trzech: patch_batch/write_file na podstawie znanego kontekstu, run_powershell dla weryfikacji, albo final z konkretnym powodem blokady.",
    ].join("\n");
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
    errorCounts.clear();

    let lastAction = null;
    let lastToolPayload = null;
    for (let step = 1; step <= maxSteps; step += 1) {
      if (signal?.aborted) throw new Error("Przerwano przez uzytkownika.");
      emit("agent-phase", { phase: "plan", step });
      compactMessages();
      const planned = await planner.plan(signal, step, failedModelIds, { lastAction, lastToolPayload });
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
        toolPayload.errorCode = toolPayload.errorCode || "repeated_action";
      } else {
        emit("agent-phase", { phase: "execute", step, tool: action.tool || "" });
        toolPayload = await toolExecutor.run(action);
        if (toolPayload?.result?.url) sourceUrls.add(String(toolPayload.result.url));
      }
      if (typeof memory.updateTaskLedger === "function") {
        memory.updateTaskLedger({ userContent, action, toolPayload, repeated: planned.repeated });
      }
      if (!toolPayload?.ok && typeof onRecoverableError === "function") {
        const key = errorLoopKey(action, toolPayload);
        const errorCount = (errorCounts.get(key) || 0) + 1;
        errorCounts.set(key, errorCount);
        emit("agent-phase", { phase: "recover", step, reason: "tool_error" });
        emit("status", {
          status: "action-cooldown",
          detail: errorCount >= 2 ? "Podobny blad powtorzyl sie; wymuszam zmiane akcji zamiast petli." : "Krotka pauza recovery przed kolejna proba...",
          step,
        });
        await waitForRecoveryWindow(700, signal);
        if (errorCount >= 2) {
          memory.append("user", buildEscalatedRecoveryInstruction(action, toolPayload, errorCount));
        }
        await onRecoverableError({ step, action, toolPayload });
      } else {
        emit("agent-phase", { phase: "observe", step, tool: action.tool || "" });
      }
      memory.append("assistant", summarizeActionForMemory(action));
      memory.append("user", `Tool result:\n${summarizeToolPayloadForMemory(toolPayload, action)}`);
      lastAction = action;
      lastToolPayload = toolPayload;
    }
    return { ok: true, final: "Osiagnieto limit krokow. Napisz, zeby kontynuowac." };
  }

  return { runTurn };
}

module.exports = { createTurnOrchestrator };
