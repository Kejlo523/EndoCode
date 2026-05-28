"use strict";

const COMMAND_SPECS = [
  { name: "pwd", usage: 'pwd {}' },
  { name: "cd", usage: 'cd {"path":"folder"}' },
  { name: "ls", usage: 'ls {"path":".","maxEntries":100}' },
  { name: "read_file", usage: 'read_file {"path":"plik","maxBytes":30000}' },
  { name: "write_file", usage: 'write_file {"path":"plik","content":"...","mode":"overwrite albo append"} (tylko male/nowe pliki; dla kodu preferuj patch_batch)' },
  { name: "mkdir", usage: 'mkdir {"path":"folder"} (tylko folder, nigdy pelna sciezka pliku typu style.css)' },
  { name: "patch_edit", usage: 'patch_edit {"path":"plik","search":"dokladny fragment","replace":"nowy fragment","count":1}' },
  { name: "patch_batch", usage: 'patch_batch {"patch":"plik\\n<<<<<<< SEARCH\\n...\\n=======\\n...\\n>>>>>>> REPLACE\\n","defaultPath":"opcjonalny"} (pusty SEARCH tylko dla nowego pliku)' },
  { name: "run_powershell", usage: 'run_powershell {"command":"npm test","timeout":60}' },
  { name: "fetch_url", usage: 'fetch_url {"url":"https://example.com","timeout":15,"raw":false}' },
  { name: "extract_media", usage: 'extract_media {"url":"https://example.com","timeout":15}' },
  { name: "download_file", usage: 'download_file {"url":"https://example.com/file.zip","path":"plik.zip"}' },
];

const ALLOWED_TOOLS = new Set(COMMAND_SPECS.map((spec) => spec.name));
const REQUIRED_ARGS_BY_TOOL = {
  cd: ["path"],
  ls: [],
  read_file: ["path"],
  write_file: ["path", "content"],
  mkdir: ["path"],
  patch_edit: ["path", "search", "replace"],
  patch_batch: [],
  run_powershell: ["command"],
  fetch_url: ["url"],
  extract_media: ["url"],
  download_file: ["url", "path"],
  pwd: [],
};

const TOOL_INTENT_CLASS = {
  fetch_url: "web",
  extract_media: "web",
  download_file: "web",
  ls: "filesystem",
  read_file: "filesystem",
  write_file: "filesystem",
  patch_edit: "filesystem",
  patch_batch: "filesystem",
  mkdir: "filesystem",
  cd: "filesystem",
  pwd: "filesystem",
  run_powershell: "shell",
};

function allowedToolNamesList() {
  return [...ALLOWED_TOOLS].sort().join(", ");
}

function buildToolsPromptBlock() {
  return COMMAND_SPECS.map((spec) => `- ${spec.usage}`).join("\n");
}

module.exports = {
  COMMAND_SPECS,
  ALLOWED_TOOLS,
  REQUIRED_ARGS_BY_TOOL,
  TOOL_INTENT_CLASS,
  allowedToolNamesList,
  buildToolsPromptBlock,
};
