# ui-pick

Pick an element in your running Vite + React app, type what should change, and the request lands in the Claude Code session already open in that project. Claude edits the file, HMR repaints the page, and Claude's reply shows next to the element. It's a dev-server-only Vite plugin plus a small channel server that Claude Code launches. Picking is done by [react-grab](https://github.com/aidenybai/react-grab).

## Setup

Requires Node 22.18+, Vite 8 and React. ui-pick isn't published, so you link it from a local checkout.

**0. Build ui-pick once** (again after pulling changes):

```sh
cd ~/projects/ui-pick && pnpm install && pnpm build
```

**1. Add the plugin to your app.** In the app's `package.json` (in a monorepo, the app package that owns `vite.config`):

```json
"devDependencies": {
  "ui-pick": "link:<path to ui-pick>"
}
```

The path is relative to that `package.json`, e.g. `link:../../../ui-pick`. Run `pnpm install`, then in `vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { claudeSession, uiPick } from "ui-pick";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), uiPick({ agent: claudeSession() })],
});
```

Options: `agent` (required) and `key`, a react-grab `activationKey` string. Leave `key` out to keep react-grab's default.

**2. Register the channel with Claude Code.** In `.mcp.json` at the project root, meaning the folder you start `claude` in:

```json
{
  "mcpServers": {
    "ui-pick": {
      "command": "node",
      "args": ["/Users/you/projects/ui-pick/dist/channel/bin.mjs"]
    }
  }
}
```

## Run

Start Claude from the project root with the channel enabled:

```sh
claude --dangerously-load-development-channels server:ui-pick
```

Channels are a Claude Code research preview. Without this flag Claude ignores the channel, and the flag and the channel API may still change.

Start `pnpm dev` too. The order doesn't matter. The dev server prints one of:

```
ui-pick → waiting for Claude
ui-pick → connected to Claude
```

and prints the line again when the state changes.

## Picking

1. Hover an element and activate react-grab: by default press **⌘C** (macOS) or **Ctrl+C**, or use your `key`.
2. In react-grab's menu for that element, choose **Send to Claude**.
3. Type what should change and press **⌘/Ctrl+Enter**. Press **Esc** to cancel.

The element gets a status badge: sending, sent, working, done, or question. Claude's reply appears in a bubble beside the element. You can keep picking while Claude works: picks queue and Claude takes them in order. If Claude isn't connected, the note box says "Claude isn't connected" and nothing is sent.

## What Claude receives

Each pick arrives as a `<channel source="ui-pick">` event. Its body holds your note, the component, the source location and the element's HTML. Its attributes are `pick_id`, `component`, `file`, `line` and `screenshot`. The source path is relative to the folder Claude was started in, or absolute when the file is outside that folder. For example, with Claude at the repo root and Vite at `apps/web`:

```
<channel source="ui-pick" pick_id="…" component="PriceCard" file="apps/web/src/components/price-card.tsx" line="42" screenshot="/var/folders/…/ui-pick-…/….png">
make the price bold

component: PriceCard
source: apps/web/src/components/price-card.tsx:42:7
html:
````html
<span class="price">$12</span>
````
</channel>
```

`screenshot` is a PNG of the picked element in a temp folder, deleted when the session ends. Claude tells the channel "working" when it starts, then "done" or "question", and those updates drive the badge and the reply bubble.

## Security

- **Dev server only.** The plugin applies only to `vite dev`, so `vite build` output contains nothing from ui-pick. It also stays off when Vitest (or anything else running Vite in `test` mode) loads your config.
- **This machine only.** The dev server accepts picks only from this machine. With `server.host` set (`--host`, Docker, phone testing) other devices can open the app, but their picks are refused, and the dev server warns about it at startup. The channel server listens on `127.0.0.1` and accepts only requests that carry its secret. The secret is stored in `.ui-pick/channel.json` in your project, readable only by your user.
- **Same page only.** The dev server accepts a pick only from the app's own origin, with a token handed to the page at load, so another site open in your browser can't send one.
- **No extra permissions.** A pick is a message to Claude. Every edit Claude makes goes through Claude Code's usual permission prompts. Claude treats the HTML and component names as data from the page, not as instructions.

## Troubleshooting

- **The dev server says "connected to Claude" but nothing reaches Claude.** Claude was started without `--dangerously-load-development-channels server:ui-pick`. The channel server still runs as a plain MCP server, but Claude ignores its events. Restart Claude with the flag.
- **It stays on "waiting for Claude".** Check that the `.mcp.json` path points to the built `dist/channel/bin.mjs`, and that Claude was started in the project folder or a parent of the Vite root. `/mcp` in Claude shows whether `ui-pick` is running.
- **`.ui-pick/` in your project.** The channel server creates it. It contains its own `.gitignore`, so git ignores it without any change to yours.
- **Your app already imports react-grab.** Remove that import. ui-pick starts react-grab itself with telemetry off. With both, whichever copy loads first wins: if it's your app's, your app's react-grab settings, telemetry included, apply.
