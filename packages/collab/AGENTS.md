# AGENTS.md — @markdawn/collab

## Key Decisions

### WebSocket Only

Does not serve HTTP. Port 1234 for WebSocket only.

### Authentication Token Priority

Session tokens checked in this order:
1. URL parameter `?token=`
2. `Authorization: Bearer <token>` header
3. `better-auth.session_token` cookie
4. `__Secure-better-auth.session_token` cookie

### Document Persistence

- Binary Yjs updates stored in `pages.ydoc` (BYTEA)
- Default: 500ms debounce, 3000ms max
- Force-save on disconnect
