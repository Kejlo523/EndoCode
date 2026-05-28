function createToolExecutor(options = {}) {
  const {
    executeTool,
    onToolResult = () => {},
    onSourceUrl = () => {},
    validateAction = null,
    getRecoveryHint = null,
  } = options;

  if (typeof executeTool !== "function") throw new Error("createToolExecutor requires executeTool");

  async function run(action) {
    try {
      if (typeof validateAction === "function") {
        const checked = validateAction(action);
        if (!checked?.ok) {
          const payload = {
            tool: action?.tool,
            ok: false,
            error: checked?.error || "Action validation failed before execution.",
            errorCode: checked?.errorCode || "executor_validation_failed",
            recoveryHint: typeof getRecoveryHint === "function" ? getRecoveryHint(new Error(checked?.error || "Action validation failed before execution."), action) : "",
          };
          onToolResult(payload);
          return payload;
        }
      }
      const result = await executeTool(action);
      onToolResult({ tool: action?.tool, ok: true, result });
      if (action?.tool === "fetch_url" && result?.url) onSourceUrl(String(result.url));
      if (action?.tool === "download_file" && action?.args?.url) onSourceUrl(String(action.args.url));
      if (action?.tool === "extract_media" && Array.isArray(result?.media_urls)) {
        for (const url of result.media_urls.slice(0, 5)) onSourceUrl(String(url));
      }
      return { ok: true, result };
    } catch (error) {
      const payload = {
        tool: action?.tool,
        ok: false,
        error: error?.message || String(error),
        recoveryHint: typeof getRecoveryHint === "function" ? getRecoveryHint(error, action) : "",
      };
      onToolResult(payload);
      return payload;
    }
  }

  return { run };
}

module.exports = { createToolExecutor };
