# Web, Media, and Data Playbook

## Web

- Use real URLs only. Do not guess long paths.
- If a URL 404s, go back to a stable entry point: homepage, docs, sitemap, API docs, or extracted links.
- Prefer official APIs, JSON, CSV, RSS, and documented endpoints over JavaScript-rendered pages.
- If a site blocks simple fetches, change source or ask for a browser-capable workflow.

## Media

- For images supplied by the user, use `analyze_image` when the Vision skill is installed.
- For icons, diagrams, and logos, prefer editable SVG unless the user specifically wants raster generation.
- For downloaded media, verify file type and basic content before using it in a final artifact.

## Data

- Keep raw downloaded data separate from cleaned outputs.
- For tables, preserve headers and data types.
- Summarize transformations so the user can audit the result.

