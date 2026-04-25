# File Editing Playbook

## Reading

- Read the target file before editing unless it is a new file.
- If the file is large, read the relevant region first and search for nearby anchors.
- Keep track of filenames, exported symbols, and adjacent conventions.

## Existing Files

- Prefer `replace_text` for focused edits when the exact old text is known.
- Use `write_file` with `append` for intentional additions to the end of a file or chunked generation.
- Use `write_file` with `overwrite` only for new files, generated artifacts, or full-file rewrites the user explicitly requested.
- Do not replace an entire existing source file to fix a small issue.
- Do not remove unrelated code, comments, imports, or user edits.

## Syntax Error Recovery

- Parse the error: file, line, column, token, and command that failed.
- Read the failing file around that line.
- Patch only the broken statement, delimiter, import, or block.
- Rerun the exact failing check.
- If the same error moves to a new line, continue with the new evidence.

## Save Failures

- If a folder is missing, create it.
- If content is too large, write smaller chunks.
- If access is denied, save an alternate file under `exports/` or `output/` and explain the workaround.
- If an exact replacement fails, reread the file and choose a more reliable anchor.

