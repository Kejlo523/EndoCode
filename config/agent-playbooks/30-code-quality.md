# Code Quality Playbook

## General

- Follow the existing style of the repository.
- Keep changes scoped to the requested behavior.
- Add abstractions only when they reduce real duplication or clarify a shared boundary.
- Prefer standard library and existing helpers over new dependencies.
- Do not leave placeholders, fake TODO implementations, or partial stubs.

## JavaScript and Electron

- Keep main-process, preload, and renderer responsibilities separate.
- Validate IPC inputs in the main process.
- Use `node --check` for changed JS files when possible.
- Keep UI events explicit and user-visible when they describe agent activity.

## Error Handling

- Error messages should name the failed operation and the likely next step.
- Avoid swallowing process startup failures; include useful log tails.
- When recovering from model/tool errors, feed the model precise recovery hints.

## User Trust

- Do not claim a check passed unless it actually ran.
- Do not report generated files that do not exist.
- Keep final summaries short, concrete, and file-oriented.

