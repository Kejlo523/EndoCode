# Documents and Presentations Playbook

## Documents

- For DOCX, use local document tooling or `create_docx` when it fits the task.
- For PDF, prefer HTML or Markdown source plus `create_pdf` so layout can be inspected and regenerated.
- Keep source files beside generated documents for future edits when practical.
- Use clear headings, tables, and page breaks intentionally.

## Presentations

- Choose the simplest reliable pipeline for the requested output.
- For fast functional PPTX, `create_pptx` is acceptable.
- For visually rich decks, create a styled Markdown/HTML source and export with a local tool such as Marp or Slidev if available.
- Do not create blank, generic slides. Each slide needs a purpose, readable hierarchy, and enough content to stand alone.

## Visual Quality

- Match style to the domain. Operational docs should be clean and readable, not overdecorated.
- Use images, diagrams, or tables only when they clarify the content.
- Avoid one-note color palettes and excessive decoration.

