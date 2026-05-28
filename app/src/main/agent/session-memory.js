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
  let taskLedger = createEmptyTaskLedger();

  function createEmptyTaskLedger(goal = "") {
    return {
      goal: String(goal || "").trim().slice(0, 360),
      currentFiles: [],
      completed: [],
      blocked: [],
      lastError: "",
      nextRequiredAction: "",
    };
  }

  function compact(value, max = 220) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
  }

  function addUniqueBounded(list, value, limit = 8) {
    const clean = compact(value, 220);
    if (!clean) return;
    const next = [clean, ...list.filter((item) => item !== clean)];
    list.splice(0, list.length, ...next.slice(0, limit));
  }

  function pathFromAction(action = {}) {
    const args = action.args || {};
    if (args.path) return String(args.path);
    if (args.defaultPath) return String(args.defaultPath);
    if (Array.isArray(args.blocks) && args.blocks[0]?.path) return String(args.blocks[0].path);
    return "";
  }

  function pathsFromToolPayload(action = {}, payload = {}) {
    const paths = [];
    const push = (value) => {
      const clean = compact(value, 220);
      if (clean) paths.push(clean);
    };
    push(pathFromAction(action));
    const result = payload?.result || {};
    push(result.path);
    if (Array.isArray(result.applied)) {
      for (const item of result.applied) push(item?.path);
    }
    return [...new Set(paths)];
  }

  function errorClassFromPayload(payload = {}) {
    const text = compact(`${payload?.errorCode || ""} ${payload?.error || ""}`, 500);
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

  function nextActionForError(errorClass, action = {}, payload = {}) {
    const pathHint = pathFromAction(action);
    if (errorClass === "search_replace_no_match") {
      return `read_file ${pathHint || "wskazanego pliku"} i napraw tylko niedopasowany SEARCH blok`;
    }
    if (errorClass === "path_directory_collision") {
      return `ls folderu nadrzednego dla ${pathHint || "sciezki"}; nie usuwaj katalogu automatycznie`;
    }
    if (errorClass === "mkdir_file_path") {
      return "utworz tylko folder nadrzedny albo stworz plik przez patch_batch z pustym SEARCH";
    }
    if (errorClass === "large_write_file_blocked") {
      return "zamien duzy write_file na surowy SEARCH/REPLACE lub patch_batch";
    }
    if (errorClass === "underbuilt_full_site_artifact") {
      return "kontynuuj pelna strone: rozbuduj plik przez patch_batch/surowy SEARCH/REPLACE zamiast placeholdera";
    }
    if (errorClass === "empty_search_existing_file") {
      return `read_file ${pathHint || "istniejacego pliku"} i uzyj dokladnego SEARCH zamiast pustego SEARCH`;
    }
    if (errorClass === "repeated_action") {
      return "nie powtarzaj tego samego odczytu; wykonaj patch_batch/write_file/run_powershell albo zakoncz finalem z konkretnym powodem";
    }
    if (payload?.recoveryHint) return compact(payload.recoveryHint, 260);
    return "napraw ostatni blad bez zmiany glownego celu zadania";
  }

  function nextActionAfterSuccess(action = {}, payload = {}) {
    const tool = action.tool || "";
    if (tool === "read_file") return "zastosuj minimalny patch albo zakoncz finalem jesli cel jest gotowy";
    if (tool === "ls") return "wybierz poprawna sciezke i kontynuuj bez zgadywania";
    if (tool === "patch_edit" || tool === "patch_batch" || tool === "write_file") return "zweryfikuj zmiane waskim checkiem albo odczytem pliku";
    if (tool === "run_powershell") return payload?.result?.exitCode === 0 ? "zakoncz finalem albo wykonaj kolejny wymagany check" : "napraw blad z outputu minimalnym patchem";
    return "";
  }

  function hardReset(nextIntentKey = "") {
    taskMessages = [];
    sessionSummary = "";
    currentIntentKey = String(nextIntentKey || "");
    taskLedger = createEmptyTaskLedger();
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
    if (!taskLedger.goal) taskLedger.goal = compact(userText, 360);
  }

  function append(role, content) {
    taskMessages.push({ role, content: String(content || "") });
    if (taskMessages.length > maxTaskMessages) {
      const overflow = taskMessages.splice(0, taskMessages.length - maxTaskMessages);
      const compact = summarize(overflow);
      if (compact) {
        sessionSummary = sessionSummary
          ? `${sessionSummary}\n${compact}`.slice(-6000)
          : compact.slice(-6000);
      }
    }
  }

  function getModelContext() {
    const blocks = [];
    if (sessionSummary) blocks.push({ role: "user", content: `Session summary:\n${sessionSummary}` });
    const taskState = getTaskStatePrompt();
    if (taskState) blocks.push({ role: "user", content: taskState });
    blocks.push(...taskMessages);
    return blocks;
  }

  function updateTaskLedger(update = {}) {
    const action = update.action || {};
    const payload = update.toolPayload || {};
    const paths = pathsFromToolPayload(action, payload);
    for (const p of paths) addUniqueBounded(taskLedger.currentFiles, p, 10);

    if (payload?.ok) {
      taskLedger.lastError = "";
      addUniqueBounded(taskLedger.completed, `${action.tool || "tool"} ok${paths[0] ? `: ${paths[0]}` : ""}`, 8);
      taskLedger.nextRequiredAction = nextActionAfterSuccess(action, payload);
      return;
    }

    const errorClass = update.repeated ? "repeated_action" : errorClassFromPayload(payload);
    const errorText = compact(payload?.error || payload?.recoveryHint || "tool error", 420);
    taskLedger.lastError = `${errorClass}${paths[0] ? ` @ ${paths[0]}` : ""}: ${errorText}`;
    addUniqueBounded(taskLedger.blocked, taskLedger.lastError, 8);
    taskLedger.nextRequiredAction = nextActionForError(errorClass, action, payload);
  }

  function getTaskStatePrompt() {
    if (!taskLedger.goal && !taskLedger.lastError && !taskLedger.currentFiles.length) return "";
    return [
      "TASK_STATE",
      `goal: ${taskLedger.goal || "(brak)"}`,
      `active_files: ${taskLedger.currentFiles.slice(0, 6).join(", ") || "(brak)"}`,
      `completed: ${taskLedger.completed.slice(0, 4).join(" | ") || "(brak)"}`,
      `blocked: ${taskLedger.blocked.slice(0, 3).join(" | ") || "(brak)"}`,
      `last_error: ${taskLedger.lastError || "(brak)"}`,
      `next_required_action: ${taskLedger.nextRequiredAction || "kontynuuj najkrotsza bezpieczna sciezka"}`,
      "rule: Zachowaj goal. Recovery naprawia ostatni blad bez zmiany celu. Po udanym read_file nie powtarzaj tego samego odczytu; przejdz do patch_batch/write_file/run_powershell albo finala z blokada.",
    ].join("\n");
  }

  function getState() {
    return {
      currentIntentKey,
      sessionSummary,
      taskMessages: taskMessages.slice(),
      taskLedger: { ...taskLedger, currentFiles: taskLedger.currentFiles.slice(), completed: taskLedger.completed.slice(), blocked: taskLedger.blocked.slice() },
    };
  }

  return {
    beginTurn,
    append,
    hardReset,
    getModelContext,
    updateTaskLedger,
    getTaskStatePrompt,
    getState,
  };
}

module.exports = { createSessionMemory };
