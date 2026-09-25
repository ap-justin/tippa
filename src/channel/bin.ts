#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startChannel } from "./channel.ts";

// stdout carries the mcp protocol; logs go to stderr
const channel = await startChannel({
	// claude code sets CLAUDE_PROJECT_DIR for the mcp servers it spawns
	cwd: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
	transport: new StdioServerTransport(),
});

async function shutdown(): Promise<void> {
	await channel.close();
	process.exit(0);
}

// a crash exit skips shutdown; only sync work runs here
process.on("exit", () => channel.releaseSync());
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// claude code ending the session closes our stdin
process.stdin.on("end", shutdown);
