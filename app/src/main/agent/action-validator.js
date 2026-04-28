"use strict";

const {
  ALLOWED_TOOLS,
  REQUIRED_ARGS_BY_TOOL,
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
  if (tool === "patch_batch") {
    const hasPatch = typeof args?.patch === "string" && args.patch.trim().length > 0;
    const hasBlocks = Array.isArray(args?.blocks) && args.blocks.length > 0;
    if (!hasPatch && !hasBlocks) {
      return {
        ok: false,
        errorCode: "missing_required_arg",
        error: "Tool 'patch_batch' requires args.patch or args.blocks.",
      };
    }
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
      "Dopuszczalne odpowiedzi:",
      "- {\"tool\":\"read_file\",\"args\":{\"path\":\"...\",\"maxBytes\":30000}}",
      "- {\"tool\":\"patch_batch\",\"args\":{\"patch\":\"...\"}}",
      "- {\"tool\":\"patch_edit\",\"args\":{\"path\":\"...\",\"search\":\"...\",\"replace\":\"...\",\"count\":1}}",
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
};

