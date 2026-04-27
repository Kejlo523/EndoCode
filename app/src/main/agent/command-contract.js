"use strict";

const COMMAND_SPECS = [
  { name: "pwd", usage: 'pwd {}' },
  { name: "cd", usage: 'cd {"path":"folder"}' },
  { name: "ls", usage: 'ls {"path":".","maxEntries":100}' },
  { name: "read_file", usage: 'read_file {"path":"plik","maxBytes":30000}' },
  { name: "write_file", usage: 'write_file {"path":"plik","content":"...","mode":"overwrite albo append"}' },
  { name: "mkdir", usage: 'mkdir {"path":"folder"}' },
  { name: "replace_text", usage: 'replace_text {"path":"plik","old":"tekst","new":"tekst","count":1}' },
  { name: "create_pdf", usage: 'create_pdf {"path":"raport.pdf","title":"Tytul","markdown":"# Tresc"} albo {"path":"raport.pdf","title":"Tytul","html":"<h1>Tresc</h1>"}' },
  { name: "create_pptx", usage: 'create_pptx {"path":"prez.pptx","title":"Tytul","markdown":"## Slajd 1\\n- punkt\\n## Slajd 2"}' },
  { name: "create_docx", usage: 'create_docx {"path":"dok.docx","title":"Tytul","markdown":"# Naglowek\\nAkapit"}' },
  { name: "run_powershell", usage: 'run_powershell {"command":"npm test","timeout":60}' },
  { name: "fetch_url", usage: 'fetch_url {"url":"https://example.com","timeout":15,"raw":false}' },
  { name: "extract_media", usage: 'extract_media {"url":"https://example.com","timeout":15}' },
  { name: "download_file", usage: 'download_file {"url":"https://example.com/file.zip","path":"plik.zip"}' },
  { name: "analyze_image", usage: 'analyze_image {"path":"plik.jpg"}' },
];

const ALLOWED_TOOLS = new Set(COMMAND_SPECS.map((spec) => spec.name));

function allowedToolNamesList() {
  return [...ALLOWED_TOOLS].sort().join(", ");
}

function buildToolsPromptBlock() {
  return COMMAND_SPECS.map((spec) => `- ${spec.usage}`).join("\n");
}

module.exports = {
  COMMAND_SPECS,
  ALLOWED_TOOLS,
  allowedToolNamesList,
  buildToolsPromptBlock,
};
