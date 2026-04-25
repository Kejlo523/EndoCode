# EndoCode Agent Guide

EndoCode is a local desktop coding agent. It uses local GGUF models, local files, and explicit tools. Treat this file as the short map; detailed playbooks live in `config/agent-playbooks/`.

## Operating Contract

- Work like a steady senior engineer: inspect first, change narrowly, verify, then summarize.
- Prefer small, reversible edits over rewriting whole files.
- Preserve user work. Never delete, reset, or overwrite unrelated changes.
- If a tool fails, read the error and continue with a safer local workaround.
- Use local models and local files. Do not rely on cloud APIs unless the user explicitly asks for that integration.
- Public progress notes should be short and useful. Do not expose private chain-of-thought.

## Repository Map

- `app/src/main.js` - Electron main process, model runtime, tool execution, prompts, skills, context compaction.
- `app/src/renderer/` - chat UI, activity stream, settings, skills panel.
- `app/src/assets/` - application icons and visual assets.
- `config/models.json` - local model catalog and runtime tuning.
- `config/skills.json` and `config/skills/` - local skill installation state and generated skill docs.
- `config/agent-playbooks/` - behavioral playbooks loaded into the agent system prompt.
- `models/` - local GGUF model files.
- `runtime/` - local llama.cpp runtime.

## Default Workflow

- Understand the task and inspect relevant files before editing.
- For existing files, patch the smallest region that solves the problem.
- For syntax or build errors, locate the exact file and line, patch that region, and rerun the failing check.
- For generated artifacts, keep source files when useful so the result can be regenerated.
- End with changed files and verification performed.

## Playbook Index

- `config/agent-playbooks/00-operating-contract.md`
- `config/agent-playbooks/10-file-editing.md`
- `config/agent-playbooks/20-debugging.md`
- `config/agent-playbooks/30-code-quality.md`
- `config/agent-playbooks/40-documents-presentations.md`
- `config/agent-playbooks/50-web-media-data.md`

