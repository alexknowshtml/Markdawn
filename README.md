# Markdawn

A knowledge base for humans and their AI agents.

Notion is a human tool with an API bolted on. Obsidian is a local vault you sync. Markdawn is built different. The same product works headful in a browser and headless via REST API. Write a page in your browser. Have an agent read, edit, and link to it via the same endpoints. No wrappers, no adapters, no dual-mode.

---

## What's Built

### Editor
- Real-time collaborative editing via WebSocket (CRDT-based — concurrent edits merge cleanly)
- Markdown-first: GFM (tables, task lists, strikethrough), LaTeX math, inline code, images
- `[[Wiki links]]` to link pages — backlinks are tracked automatically
- Table of contents generated from headings
- Page titles, icons, and cover images
- Properties panel for page metadata

### Organization
- Workspaces (team or project spaces)
- Folders with nesting — create, rename, delete, move pages between them
- Search with filters (date range, parent folder)
- Command palette (`Cmd+K` / `Ctrl+K`)
- Tags, favorites, and trash
- Dark mode

### Security
- OAuth login (Google, GitHub)
- Public share links for any page — no account required to view
- Workspace-level access control

### Import
- Obsidian vault import — wiki links, folders, and markdown files map directly
- Markdown export

### API
- REST API from day one — the same API the browser uses
- Pages as structured data: titles, content, tags, timestamps, relationships

---

## The Product Thesis

Most "AI + docs" tools are a human app with an agent API wrapper. Markdawn inverts this: the content layer works identically headful and headless. Agents aren't "supported" — they're first-class users. A page created by an agent looks exactly like a page created by a human. A wiki link from a human to an agent-created page works the same as any other link.

This means:
- No "agent mode" toggle
- No separate data stores for human vs. agent content
- No sync layer between "your notes" and "agent memory"
- The graph is unified. The API is the product.

---

## Self-Hosted

Open source under GNU AGPL v3. Run it on your own infrastructure.

- [Deployment Guide](docs/deployment_guide.md) — step-by-step for a single VPS with Caddy, Podman, and PostgreSQL
- [deploy/](deploy/) — `setup.sh` (one-time server bootstrap) and `deploy.sh` (incremental deploy)

---

## Author

Atharva Verma  
[GitHub](https://github.com/atharva-again/Markdawn)  
[atharva.verma18@gmail.com](mailto:atharva.verma18@gmail.com)
