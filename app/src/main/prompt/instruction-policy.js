"use strict";

const fs = require("node:fs");
const path = require("node:path");

function createInstructionPolicyEngine(options = {}) {
  const appHome = options.appHome;
  const maxChars = Number(options.maxChars || 18000);
  const readFile = options.readFile;
  const playbookFilesProvider = options.playbookFilesProvider;

  function toRel(filePath) {
    return path.relative(appHome, filePath).replaceAll("\\", "/") || path.basename(filePath);
  }

  function loadBlocks(workspaceRoot) {
    const files = [
      path.join(appHome, "AGENTS.md"),
      ...(path.resolve(workspaceRoot || "") !== path.resolve(appHome)
        ? [path.join(workspaceRoot, "AGENTS.md"), path.join(workspaceRoot, "CLAUDE.md")]
        : []),
      ...(playbookFilesProvider ? playbookFilesProvider() : []),
    ];

    const seen = new Set();
    const blocks = [];
    for (const file of files) {
      const resolved = path.resolve(file);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      if (!fs.existsSync(resolved)) continue;
      const text = String(readFile?.(resolved) || "").trim();
      if (!text) continue;
      blocks.push({ filePath: resolved, rel: toRel(resolved), text });
    }
    return blocks;
  }

  function buildPrompt(workspaceRoot) {
    const blocks = loadBlocks(workspaceRoot);
    let total = "";
    const loaded = [];
    const omitted = [];
    for (const block of blocks) {
      const chunk = `\n\n--- ${block.rel} ---\n${block.text}`;
      if ((total.length + chunk.length) > maxChars) {
        omitted.push(block.rel);
        continue;
      }
      total += chunk;
      loaded.push(block.rel);
    }
    return {
      prompt: total.trim(),
      meta: {
        loadedFiles: loaded,
        omittedFiles: omitted,
        sizeChars: total.length,
      },
    };
  }

  return { buildPrompt };
}

module.exports = { createInstructionPolicyEngine };
