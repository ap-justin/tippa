#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startChannel, startInertChannel } from "./channel.ts";
import { isLoadedAsChannel } from "./launch.ts";

// the key under `mcpServers` in the project's .mcp.json, as the readme sets it up
const SERVER_NAME = "ui-pick";

// stdout carries the mcp protocol; logs go to stderr
const transport = new StdioServerTransport();
const channel = (await isLoadedAsChannel(SERVER_NAME))
	? await startChannel({
			// claude code sets CLAUDE_PROJECT_DIR for the mcp servers it spawns
			cwd: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
			transport,
		})
	: await startInert();

async function startInert() {
	console.error(
		`ui-pick: inactive; picks reach claude only when it's started with --dangerously-load-development-channels server:${SERVER_NAME}`,
	);
	return startInertChannel(transport);
}

async function shutdown(): Promise<void> {
	await channel.close();
	process.exit(0);
}

// a crash exit skips shutdown; only sync work runs here
process.on("exit", () => channel.releaseSync());
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// closing the terminal hangs up claude's process group
process.on("SIGHUP", shutdown);
// claude code ending the session closes our stdin
process.stdin.on("end", shutdown);
