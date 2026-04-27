"use strict";

const {
  ALLOWED_TOOLS,
  REQUIRED_ARGS_BY_TOOL,
  TOOL_INTENT_CLASS,
  allowedToolNamesList,
} = require("./command-contract");

function normalizeAction(rawAction) {
  if (!rawAction || typeof rawAction !== "object" || Array.isArray(rawAction)) {
    return { ok: false, errorCode: "action_not_object", error: "Action must be a JSON object." };
  }
  const note = typeof rawAction.note === "string" ? rawAction.note.trim() : "";
  const tool = typeof rawAction.tool === "string" ? rawAction.tool.trim() : "";
  const final = typeof rawAction.final === "string" ? rawAction.final.trim() : "";
  const args = rawAction.args && typeof rawAction.args === "object" && !Array.isArray(rawAction.args)
    ? rawAction.args
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
  const required = REQUIRED_ARGS_BY_TOOL[tool] || [];
  for (const key of required) {
    const value = args[key];
    if (value === undefined || value === null || String(value).trim() === "") {
      return { ok: false, errorCode: "missing_required_arg", error: `Missing required arg '${key}' for tool '${tool}'.` };
    }
  }
  return { ok: true };
}

function validateIntentGuard(tool, intentClass) {
  if (!intentClass || intentClass === "general") return { ok: true };
  const toolClass = TOOL_INTENT_CLASS[tool] || "general";
  if (intentClass === toolClass) return { ok: true };
  if (intentClass === "filesystem" && toolClass === "document") return { ok: true };
  return {
    ok: false,
    errorCode: "intent_mismatch",
    error: `Tool '${tool}' is incompatible with current intent '${intentClass}'.`,
  };
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
  const intent = options.intentClass || "general";
  const intentCheck = validateIntentGuard(tool, intent);
  if (!intentCheck.ok) return intentCheck;
  return { ok: true, action: { ...action, args: action.args || {} } };
}

function buildMachineRepairPrompt(validationError, rawResponse) {
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
};

