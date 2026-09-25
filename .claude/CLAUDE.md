<!-- kru v0.116.0 · derived 2026-09-25 · /kru:setup to re-derive -->
## Team

Load **`kru:lead`** before building, reviewing, or dispatching a seat — it carries how the team works.

- **plugin, channel, package config** → `kru:extension-builder` — `src/plugin.ts`, `src/claude-session.ts`, `src/channel/**`, tsdown/tsconfig/biome/vitest configs (vite ^8.3.1, @modelcontextprotocol/sdk 1.30.1)
- **page overlay** → `kru:web-components-builder` — `src/client/**`, shadow-root UI over react-grab 0.2.0 + bippy 0.6.1 + modern-screenshot 4.7.0
- **skills** → `kru:zod`, `vitest`, `typescript` — zod 4.6.5 · vitest 5.0.1 · typescript 7.0.2
- **design** — no token file; overlay styling lives in `src/client/styles.ts`, kept neutral (brief v1)
- **screens** — no dev server here; the overlay renders only inside a consumer app's Vite dev server

A slice reaching a stack no seat above covers is a question for the user, naming the seat it would need — never a nearby seat pressed into the gap.

## Gotchas
- **MCP SDK stays on v1** — Claude Code doesn't register a channel from a server on protocol 2026-07-28 (SDK v2) ← code.claude.com/docs/en/mcp, channels section
- **`dist/client` is served raw** by the consumer's Vite over `/@fs/`, so it carries no bare imports: react-grab, bippy and modern-screenshot are devDependencies bundled in (`tsdown.config.ts`), and client code imports zod as types only (`src/protocol.ts`). Nothing tests this.
- **Full suite is cheap** — ~11 s over 13 files, node + happy-dom, no browser. Run `pnpm check` whole. ← `pnpm check` 2026-09-26
