# AGENTS.md — @markdawn/web

## Gotchas

1. **Better Auth baseURL** — must be FRONTEND URL (e.g., `http://localhost:5173`), NOT the API server
2. **Buttons** — `cursor-pointer`
3. Users can pick emoji icons for pages via the emoji picker

## Milkdown Editor

### Wiki Links

Links are **marks, not nodes**:

```typescript
[{ type: "text", text: linkText, marks: [{ type: "link", attrs: { href } }] }]
```

### Collaboration Persistence

- HocuspocusProvider handles real-time sync AND persistence automatically
- **No manual save needed**
- Undo/redo may behave unexpectedly with collaboration enabled

### TypeScript

Editor types may conflict with strict TS. Use `unknown` with narrowing.

## Styling

### Tailwind CSS v4

- CSS-first config (`@import "tailwindcss"` + `@theme`) — **no `tailwind.config.js`**
- **FOUC Prevention**: Inline script in `<head>` applies `dark` class before React hydrates
