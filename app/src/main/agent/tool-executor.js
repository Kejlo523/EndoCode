function createToolExecutor(options = {}) {
  const {
    executeTool,
    onToolResult = () => {},
    onSourceUrl = () => {},
  } = options;

  if (typeof executeTool !== "function") throw new Error("createToolExecutor requires executeTool");

  async function run(action) {
    try {
      const result = await executeTool(action);
      onToolResult({ tool: action?.tool, ok: true, result });
      if (action?.tool === "fetch_url" && result?.url) onSourceUrl(String(result.url));
      if (action?.tool === "download_file" && action?.args?.url) onSourceUrl(String(action.args.url));
      if (action?.tool === "extract_media" && Array.isArray(result?.media_urls)) {
        for (const url of result.media_urls.slice(0, 5)) onSourceUrl(String(url));
      }
      return { ok: true, result };
    } catch (error) {
      const payload = { tool: action?.tool, ok: false, error: error?.message || String(error) };
      onToolResult(payload);
      return payload;
    }
  }

  return { run };
}

module.exports = { createToolExecutor };
