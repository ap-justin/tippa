#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startChannel } from "./channel.ts";

// stdout carries the mcp protocol; logs go to stderr
const channel = await startChannel({
	cwd: process.cwd(),
	transport: new StdioServerTransport(),
});

async function shutdown(): Promise<void> {
	await channel.close();
	process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// claude code ending the session closes our stdin
process.stdin.on("end", shutdown);
