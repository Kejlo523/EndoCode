"use strict";

const {
  ALLOWED_TOOLS,
  REQUIRED_ARGS_BY_TOOL,
  allowedToolNamesList,
} = require("./command-contract");

const FILE_LIKE_EXT_RE = /\.(html?|css|scss|sass|js|mjs|cjs|jsx|ts|tsx|json|md|py|ps1|sh|bat|cmd|java|cs|go|rs|php|rb|c|h|cpp|cc|cxx|hpp|sql|xml|ya?ml|toml|ini|txt)$/i;
const KNOWN_FILE_NAMES = new Set(["dockerfile", "makefile", "rakefile", "gemfile", "procfile", "readme", "license"]);
const PLACEHOLDER_PATH_RE = /(^|[\\/])(?:sciezka|ścieżka|path)[\\/](?:do|to)[\\/]/i;

function normalizeToolArgsFromRoot(rawAction, toolName) {
  if (!rawAction || typeof rawAction !== "object" || rawAction.args !== undefined || !toolName) return rawAction;
  const argKeysByTool = {
    cd: ["path"],
    ls: ["path", "maxEntries"],
    read_file: ["path", "maxBytes"],
    write_file: ["path", "content", "mode", "allowWholeFileOverwrite", "allowLargeJsonContent"],
    mkdir: ["path"],
    patch_edit: ["path", "search", "replace", "count"],
    patch_batch: ["patch", "defaultPath", "blocks"],
    run_powershell: ["command", "timeout", "cwd"],
    fetch_url: ["url", "timeout", "raw", "query", "search", "q"],
    extract_media: ["url", "timeout"],
    download_file: ["url", "path"],
  };
  const args = {};
  for (const key of argKeysByTool[toolName] || []) {
    if (rawAction[key] !== undefined) args[key] = rawAction[key];
  }
  return Object.keys(args).length ? { ...rawAction, args } : rawAction;
}

function looksLikeFilePath(value = "") {
  const raw = String(value || "").trim().replace(/\\/g, "/");
  if (!raw || raw.endsWith("/")) return false;
  const name = raw.split("/").pop().toLowerCase();
  return KNOWN_FILE_NAMES.has(name) || FILE_LIKE_EXT_RE.test(name);
}

function looksLikePlaceholderPath(value = "") {
  return PLACEHOLDER_PATH_RE.test(String(value || "").replace(/\\/g, "/"));
}

function validatePatchBatchArgs(args = {}) {
  const hasPatch = typeof args?.patch === "string" && args.patch.trim().length > 0;
  const hasBlocks = Array.isArray(args?.blocks) && args.blocks.length > 0;
  if (!hasPatch && !hasBlocks) {
    return {
      ok: false,
      errorCode: "missing_required_arg",
      error: "Tool 'patch_batch' requires args.patch or args.blocks.",
    };
  }
  if (!hasBlocks) return { ok: true };
  for (let index = 0; index < args.blocks.length; index += 1) {
    const block = args.blocks[index] || {};
    if (block.searchChars !== undefined || block.replaceChars !== undefined || block.patchChars !== undefined) {
      return {
        ok: false,
        errorCode: "patch_batch_metadata_not_executable",
        error:
          "patch_batch dostał metadane pamięci (searchChars/replaceChars/patchChars), a nie prawdziwy patch. Zwroc surowe bloki SEARCH/REPLACE albo blocks z polami path/search/replace.",
      };
    }
    if (typeof block.path !== "string" || !block.path.trim()) {
      return { ok: false, errorCode: "invalid_patch_block", error: `patch_batch block ${index + 1} requires non-empty path.` };
    }
    if (looksLikePlaceholderPath(block.path)) {
      return {
        ok: false,
        errorCode: "placeholder_path",
        error: `patch_batch block ${index + 1} uses placeholder path '${block.path}'. Uzyj realnej sciezki z zadania/workspace.`,
      };
    }
    if (typeof block.search !== "string" || typeof block.replace !== "string") {
      return {
        ok: false,
        errorCode: "invalid_patch_block",
        error: `patch_batch block ${index + 1} requires string fields search and replace, not only metadata.`,
      };
    }
    if (!block.search.trim() && !block.replace.trim()) {
      return { ok: false, errorCode: "empty_patch_block", error: `patch_batch block ${index + 1} has empty SEARCH and empty REPLACE.` };
    }
  }
  return { ok: true };
}

function normalizeAction(rawAction) {
  if (!rawAction || typeof rawAction !== "object" || Array.isArray(rawAction)) {
    return { ok: false, errorCode: "action_not_object", error: "Action must be a JSON object." };
  }
  const note = typeof rawAction.note === "string" ? rawAction.note.trim() : "";
  const tool = typeof rawAction.tool === "string" ? rawAction.tool.trim() : "";
  const final = typeof rawAction.final === "string" ? rawAction.final.trim() : "";
  const withNormalizedArgs = normalizeToolArgsFromRoot(rawAction, tool);
  const args = withNormalizedArgs.args && typeof withNormalizedArgs.args === "object" && !Array.isArray(withNormalizedArgs.args)
    ? withNormalizedArgs.args
    : {};

  if (final && tool) {
    return {
      ok: false,
      errorCode: "mixed_final_and_tool",
      error: "Action cannot include both final and tool.",
    };
  }

  if (final) return { ok: true, action: { note, final } };
  if (!tool) {
    return {
      ok: false,
      errorCode: "missing_tool_or_final",
      error: "Action must include either final or tool.",
    };
  }
  return { ok: true, action: { note, tool, args } };
}

function classifyIntent(userText = "") {
  const text = String(userText || "").toLowerCase();
  if (/\b(wyszukaj|search|internet|web|online|kto to jest|co ostatnio)\b/.test(text)) return "web";
  if (/\b(plik|file|folder|katalog|html|strona|kod|napisz plik|zapisz)\b/.test(text)) return "filesystem";
  if (/\b(pdf|pptx|docx|prezentacj|dokument)\b/.test(text)) return "document";
  if (/\b(terminal|powershell|shell|komenda|command)\b/.test(text)) return "shell";
  return "general";
}

function validateRequiredArgs(tool, args) {
  if (tool === "patch_batch") {
    return validatePatchBatchArgs(args);
  }
  const required = REQUIRED_ARGS_BY_TOOL[tool] || [];
  for (const key of required) {
    const value = args[key];
    if (value === undefined || value === null || String(value).trim() === "") {
      return { ok: false, errorCode: "missing_required_arg", error: `Missing required arg '${key}' for tool '${tool}'.` };
    }
  }
  return { ok: true };
}

function validateAction(rawAction, options = {}) {
  const normalized = normalizeAction(rawAction);
  if (!normalized.ok) return normalized;
  const action = normalized.action;
  if (action.final) {
    if (!action.final.trim()) return { ok: false, errorCode: "empty_final", error: "Final cannot be empty." };
    return { ok: true, action };
  }

  const tool = action.tool;
  if (!ALLOWED_TOOLS.has(tool)) {
    return {
      ok: false,
      errorCode: "unknown_tool",
      error: `Unknown tool '${tool}'. Allowed tools: ${allowedToolNamesList()}.`,
    };
  }
  const req = validateRequiredArgs(tool, action.args || {});
  if (!req.ok) return req;
  if (tool === "mkdir" && looksLikeFilePath(action.args?.path)) {
    return {
      ok: false,
      errorCode: "mkdir_file_path",
      error:
        `mkdir path '${action.args.path}' wyglada jak plik. Dla pliku uzyj patch_batch z pustym SEARCH albo write_file; mkdir tylko dla folderu nadrzednego.`,
    };
  }
  const actionPath = action.args?.path || action.args?.defaultPath || "";
  if (actionPath && looksLikePlaceholderPath(actionPath)) {
    return {
      ok: false,
      errorCode: "placeholder_path",
      error: `Sciezka '${actionPath}' wyglada jak placeholder. Uzyj realnej sciezki pliku/folderu z workspace.`,
    };
  }
  return { ok: true, action: { ...action, args: action.args || {} } };
}

function buildMachineRepairPrompt(validationError, rawResponse) {
  const errText = String(validationError?.error || "unknown");
  if (/SEARCH_REPLACE_NO_EXACT_MATCH/i.test(errText)) {
    return [
      "ACTION_FORMAT_ERROR",
      `error_code=${validationError?.errorCode || "tool_error"}`,
      `error=${errText.slice(0, 260)}`,
      "PATCH_BLOCK_REPAIR_REQUIRED",
      "Napraw TEN SAM patch (bez zmiany celu).",
      "1) Uzyj read_file dla wskazanego pliku i skopiuj fragment 1:1 do SEARCH (z whitespace).",
      "2) Zwroc patch_batch albo patch_edit z mniejszymi blokami.",
      "3) Nie uzywaj write_file overwrite dla istniejacego pliku.",
      "Mozesz tez zwrocic surowe bloki SEARCH/REPLACE bez JSON; runtime zamieni je na patch_batch.",
      "Dla nowego pliku uzyj pustego SEARCH.",
      "Dopuszczalne odpowiedzi:",
      "- {\"tool\":\"read_file\",\"args\":{\"path\":\"...\",\"maxBytes\":30000}}",
      "- {\"tool\":\"patch_batch\",\"args\":{\"patch\":\"...\"}}",
      "- {\"tool\":\"patch_edit\",\"args\":{\"path\":\"...\",\"search\":\"...\",\"replace\":\"...\",\"count\":1}}",
      "- albo surowo: src/app.js\\n<<<<<<< SEARCH\\n...\\n=======\\n...\\n>>>>>>> REPLACE",
      `last_raw=${String(rawResponse || "").slice(0, 700)}`,
    ].join("\n");
  }
  if (/FULL_SITE_UNDERBUILT_ARTIFACT/i.test(errText)) {
    return [
      "ACTION_FORMAT_ERROR",
      `error_code=${validationError?.errorCode || "tool_error"}`,
      `error=${errText.slice(0, 360)}`,
      "UNDERBUILT_FULL_SITE_REPAIR_REQUIRED",
      "Zachowaj ten sam cel zadania: uzytkownik chce pelna/rozbudowana strone.",
      "Nie zapisuj placeholdera jako gotowego efektu.",
      "Zwroc kompletna zawartosc pliku przez patch_batch/surowy SEARCH/REPLACE albo kontynuuj realnymi sekcjami.",
      "Dla kodu nie pakuj duzego CSS/HTML w escaped JSON write_file, jesli mozesz uzyc SEARCH/REPLACE.",
      `last_raw=${String(rawResponse || "").slice(0, 700)}`,
    ].join("\n");
  }
  if (/repeated_action|Zablokowano zapetlenie|zapetlenie/i.test(errText)) {
    return [
      "ACTION_FORMAT_ERROR",
      `error_code=${validationError?.errorCode || "tool_error"}`,
      `error=${errText.slice(0, 360)}`,
      "REPEATED_ACTION_REPAIR_REQUIRED",
      "Nie powtarzaj tej samej akcji.",
      "Jesli powtorzony krok byl read_file/ls, masz juz kontekst z wyniku narzedzia.",
      "Nastepna odpowiedz musi byc patch_batch/write_file/run_powershell albo final z konkretnym powodem blokady.",
      "Nie odpowiadaj pytaniem o zakres, jesli zakres jest w historii.",
      `last_raw=${String(rawResponse || "").slice(0, 700)}`,
    ].join("\n");
  }
  if (/patch_batch_metadata_not_executable|placeholder_path|mkdir_file_path|EMPTY_SEARCH_EXISTING_FILE_BLOCKED|wyglada jak plik|To nie jest plik|path is directory|EISDIR|katalog/i.test(errText)) {
    return [
      "ACTION_FORMAT_ERROR",
      `error_code=${validationError?.errorCode || "tool_error"}`,
      `error=${errText.slice(0, 360)}`,
      "PATH_COLLISION_OR_FILE_PATH_REPAIR_REQUIRED",
      "Zachowaj ten sam cel zadania. Nie zgaduj nowej sciezki.",
      "1) Jesli sciezka ma byc plikiem, NIE uzywaj mkdir na pelnej sciezce pliku.",
      "2) Nie uzywaj placeholderow typu sciezka/do/index.html ani path/to/file.",
      "3) Jesli skopiowales searchChars/replaceChars/patchChars z TASK_STATE, to NIE jest patch. Zwroc prawdziwy SEARCH/REPLACE.",
      "4) Dla nowego pliku zwroc patch_batch/surowy SEARCH/REPLACE z pustym SEARCH albo write_file. Dla istniejacego pliku uzyj read_file i dokladnego SEARCH.",
      "5) Jesli istnieje kolizja katalogu z plikiem, zakoncz finalem z konkretnym powodem albo utworz plik pod poprawna nazwa.",
      `last_raw=${String(rawResponse || "").slice(0, 700)}`,
    ].join("\n");
  }
  return [
    "ACTION_FORMAT_ERROR",
    `error_code=${validationError?.errorCode || "unknown"}`,
    `error=${String(validationError?.error || "unknown").slice(0, 260)}`,
    "Return ONE JSON object only:",
    "- final: {\"final\":\"...\"}",
    "- tool call: {\"tool\":\"...\",\"args\":{...}}",
    "No prose, no markdown, no arrays.",
    `last_raw=${String(rawResponse || "").slice(0, 700)}`,
  ].join("\n");
}

module.exports = {
  classifyIntent,
  validateAction,
  buildMachineRepairPrompt,
  normalizeToolArgsFromRoot,
  looksLikeFilePath,
  looksLikePlaceholderPath,
};

