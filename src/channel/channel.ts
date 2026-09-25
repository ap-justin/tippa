import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { removeDiscovery, writeDiscovery } from "./discovery.ts";
import { formatContent, formatMeta, type Pick, pickSchema } from "./pick.ts";

const MAX_BODY_BYTES = 10 * 1024 * 1024;

const INSTRUCTIONS = [
	'A <channel source="ui-pick"> event is a UI change request the developer sent from their browser by picking an element in their running app.',
	"The body holds their note, the React component, its source file:line and the element's html; the tag's pick_id, component, file and line attributes repeat them.",
	"When a screenshot attribute is present, read that file path to see the element.",
	'Call the reply tool with the pick_id: status "working" when you start, "done" with a one-line summary after the edit, "question" when you need the developer\'s answer.',
].join("\n");

export interface ChannelOptions {
	/** project root the discovery file is written under */
	cwd: string;
	transport: Transport;
}

export interface Channel {
	close(): Promise<void>;
}

export async function startChannel({
	cwd,
	transport,
}: ChannelOptions): Promise<Channel> {
	const listeners = new Set<ServerResponse>();

	const mcp = new McpServer(
		{ name: "ui-pick", version: "0.0.0" },
		{
			capabilities: { experimental: { "claude/channel": {} }, tools: {} },
			instructions: INSTRUCTIONS,
		},
	);
	mcp.registerTool(
		"reply",
		{
			description:
				"Report progress on a ui-pick request back to the developer's browser, shown beside the picked element.",
			inputSchema: {
				pick_id: z.string().describe("pick_id from the <channel> tag"),
				status: z.enum(["working", "done", "question"]),
				message: z
					.string()
					.describe("one line: what you did, or the question to answer"),
			},
		},
		async ({ pick_id, status, message }) => {
			const event = `data: ${JSON.stringify({ pickId: pick_id, status, message })}\n\n`;
			for (const listener of listeners) listener.write(event);
			const text =
				listeners.size > 0
					? `sent to ${listeners.size} browser listener(s)`
					: "no browser listening (vite dev server may be down); nothing to do";
			return { content: [{ type: "text", text }] };
		},
	);
	await mcp.connect(transport);

	async function sendPick(pick: Pick): Promise<void> {
		let screenshotPath: string | undefined;
		if (pick.screenshot) {
			const dir = join(tmpdir(), "ui-pick");
			await mkdir(dir, { recursive: true });
			screenshotPath = join(dir, `${pick.pickId}.png`);
			await writeFile(screenshotPath, pick.screenshot);
		}
		await mcp.server.notification({
			method: "notifications/claude/channel",
			params: {
				content: formatContent(pick),
				meta: formatMeta(pick, screenshotPath),
			},
		});
	}

	const secret = randomBytes(32).toString("hex");

	async function handle(req: IncomingMessage, res: ServerResponse) {
		if (!hasSecret(req, secret)) {
			req.resume();
			return sendJson(res, 401, { error: "missing or wrong x-ui-pick-secret" });
		}
		if (req.method === "POST" && req.url === "/pick") {
			const body = await readBody(req, MAX_BODY_BYTES);
			if (body === undefined) {
				return sendJson(res, 413, { error: "body over 10 MB" });
			}
			let json: unknown;
			try {
				json = JSON.parse(body);
			} catch {
				return sendJson(res, 400, { error: "body is not valid json" });
			}
			const parsed = pickSchema.safeParse(json);
			if (!parsed.success) {
				return sendJson(res, 400, { error: z.prettifyError(parsed.error) });
			}
			await sendPick(parsed.data);
			return sendJson(res, 202, { pickId: parsed.data.pickId, status: "sent" });
		}
		if (req.method === "GET" && req.url === "/events") {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
			});
			res.flushHeaders();
			listeners.add(res);
			res.on("close", () => listeners.delete(res));
			return;
		}
		if (req.method === "GET" && req.url === "/health") {
			return sendJson(res, 200, { ok: true });
		}
		req.resume();
		sendJson(res, 404, { error: "not found" });
	}

	const http = createServer((req, res) => {
		handle(req, res).catch((error: unknown) => {
			console.error("ui-pick: request failed", error);
			if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
		});
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	const { port } = http.address() as AddressInfo;
	await writeDiscovery(cwd, { port, secret, pid: process.pid });

	let closing: Promise<void> | undefined;
	return {
		close() {
			closing ??= (async () => {
				removeDiscovery(cwd, secret);
				http.closeAllConnections();
				await new Promise((resolve) => http.close(resolve));
				await mcp.close();
			})();
			return closing;
		},
	};
}

function hasSecret(req: IncomingMessage, secret: string): boolean {
	const given = req.headers["x-ui-pick-secret"];
	if (typeof given !== "string") return false;
	// hashing first gives equal-length buffers, so a length mismatch leaks nothing
	const digest = (value: string) => createHash("sha256").update(value).digest();
	return timingSafeEqual(digest(given), digest(secret));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

/** resolves undefined once the body passes `limit`, after draining the rest */
async function readBody(
	req: IncomingMessage,
	limit: number,
): Promise<string | undefined> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req as AsyncIterable<Buffer>) {
		size += chunk.length;
		if (size <= limit) chunks.push(chunk);
	}
	return size > limit ? undefined : Buffer.concat(chunks).toString("utf8");
}
