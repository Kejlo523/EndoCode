"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

function createRuntimeManifestStore(options = {}) {
  const appHome = options.appHome || process.cwd();
  const runtimeDir = path.join(appHome, "runtime");
  const manifestPath = path.join(runtimeDir, "active-runtime.json");
  const expectedServerName = process.platform === "win32" ? "llama-server.exe" : "llama-server";

  function readManifest() {
    try {
      const raw = fs.readFileSync(manifestPath, "utf8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  async function writeManifest(patch = {}) {
    const previous = readManifest() || {};
    const next = {
      ...previous,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await fsp.mkdir(runtimeDir, { recursive: true });
    await fsp.writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  }

  function resolveActiveServerPath(manifest = readManifest()) {
    const fromManifest = String(manifest?.serverExe || "").trim();
    if (fromManifest && fs.existsSync(fromManifest)) return fromManifest;
    return null;
  }

  function findServerRecursively() {
    if (!fs.existsSync(runtimeDir)) return null;
    const stack = [runtimeDir];
    while (stack.length) {
      const dir = stack.pop();
      if (!dir || !fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        if (entry.isFile() && entry.name.toLowerCase() === expectedServerName.toLowerCase()) return full;
      }
    }
    return null;
  }

  function getActiveServerPath() {
    const manifest = readManifest();
    return resolveActiveServerPath(manifest) || findServerRecursively();
  }

  return {
    manifestPath,
    readManifest,
    writeManifest,
    getActiveServerPath,
  };
}

module.exports = { createRuntimeManifestStore };
