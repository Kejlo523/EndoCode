# Debugging Playbook

## First Principles

- Reproduce the failure with the smallest command.
- Preserve the exact error text.
- Form one hypothesis at a time.
- Prefer evidence from logs, stack traces, config files, and current process state.

## Runtime and Process Issues

- Check ports and running processes when a local server appears hung.
- If a process died early, inspect its stderr/stdout log before waiting for timeouts.
- If a port is occupied by an orphan process, use the kill switch or kill that specific PID.
- After changing runtime args, smoke test the endpoint directly.

## Dependency Issues

- On Windows, check commands with `Get-Command` or `where.exe`.
- For Python, prefer `py -3 -m pip ...` when available.
- For Node, inspect `package.json` scripts before inventing commands.
- Do not install global tools unless local `npx` or project dependencies are unsuitable.

## Verification

- Run syntax checks before broad tests.
- Use the narrowest test that proves the fix, then broader checks if the touched area is risky.
- If verification cannot run, say exactly why and what remains unverified.

