import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { Connect, Logger, Plugin } from "vite";
import { z } from "zod";
import type { AgentAdapter, AgentConnection } from "./agent.ts";
import { pickSchema } from "./channel/pick.ts";
import {
	type ClientConfig,
	REPLY_EVENT,
	STATUS_EVENT,
	STATUS_REQUEST_EVENT,
} from "./protocol.ts";

export interface UiPickOptions {
	/** the agent picks are sent to, e.g. `claudeSession()` */
	agent: AgentAdapter;
	/** pick hotkey passed to the browser client; defaults to react-grab's */
	key?: string;
}

const NAME = "ui-pick";
const ENDPOINT = "/__ui-pick/pick";
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_HTML_CHARS = 4000;
const LOADER_ID = "virtual:ui-pick/client";
const RESOLVED_LOADER_ID = `\0${LOADER_ID}`;
// extensionless so vite's resolver finds src/client/index.ts and dist/client/index.js alike
const CLIENT_ENTRY = fileURLToPath(new URL("./client/index", import.meta.url));

// the helper checks the screenshot is a png; here it stays the base64 the client sent
const pickRequestSchema = pickSchema.extend({
	html: z.string().transform((html) => html.slice(0, MAX_HTML_CHARS)),
	screenshot: z.base64().optional(),
});

export function uiPick(options: UiPickOptions): Plugin {
	let token = "";
	let connection: AgentConnection | undefined;
	return {
		name: NAME,
		apply: "serve",
		applyToEnvironment: (environment) =>
			environment.config.consumer === "client",
		configResolved() {
			validate(options);
		},
		configureServer(server) {
			token = randomBytes(32).toString("hex");
			const { agent } = options;
			const { logger, root } = server.config;
			const hot = server.environments.client.hot;
			const agentConnection = agent.connect({ root, logger });
			connection = agentConnection;
			agentConnection.onStatus((status) => {
				logger.info(
					status === "connected"
						? `ui-pick → connected to ${agent.label}`
						: `ui-pick → waiting for ${agent.label}`,
				);
				hot.send(STATUS_EVENT, { status });
			});
			agentConnection.onReply((reply) => hot.send(REPLY_EVENT, reply));
			hot.on(STATUS_REQUEST_EVENT, (_, client) =>
				client.send(STATUS_EVENT, { status: agentConnection.status }),
			);
			server.middlewares.use(pickEndpoint(token, agentConnection, logger));
		},
		async buildEnd() {
			await connection?.close();
		},
		transform: {
			// every dev page with hmr runs vite's client, including ssr frameworks with no index.html
			filter: { id: /\/vite\/dist\/client\/client\.mjs$/ },
			handler(code) {
				// appended, so no existing line moves and the map stays valid
				return {
					code: `${code}\nimport(${JSON.stringify(LOADER_ID)});\n`,
					map: null,
				};
			},
		},
		resolveId: {
			filter: { id: new RegExp(`^${LOADER_ID}$`) },
			handler: () => RESOLVED_LOADER_ID,
		},
		load: {
			filter: { id: new RegExp(`^\0${LOADER_ID}$`) },
			handler() {
				const config: ClientConfig = {
					token,
					endpoint: ENDPOINT,
					...(options.key !== undefined && { key: options.key }),
				};
				return [
					`import { start } from ${JSON.stringify(CLIENT_ENTRY)};`,
					`start(${JSON.stringify(config)});`,
					`import.meta.hot?.send(${JSON.stringify(STATUS_REQUEST_EVENT)});`,
				].join("\n");
			},
		},
	};
}

function validate(options: UiPickOptions): void {
	const { agent, key } = options ?? {};
	if (typeof agent?.connect !== "function") {
		throw new Error(
			`[${NAME}] options.agent must be an agent adapter, e.g. uiPick({ agent: claudeSession() })`,
		);
	}
	if (key !== undefined && (typeof key !== "string" || key.length === 0)) {
		throw new Error(
			`[${NAME}] options.key must be a non-empty string, or omitted for react-grab's default`,
		);
	}
}

/**
 * `POST /__ui-pick/pick` → 202 `{ pickId, status: "sent" }`, or `{ error }` with
 * 401 `unauthorized`, 405 `method_not_allowed`, 413 `too_large`, 400 `invalid_pick`,
 * 503 `not_connected`, 502 `send_failed`
 */
function pickEndpoint(
	token: string,
	agent: AgentConnection,
	logger: Logger,
): Connect.NextHandleFunction {
	async function handle(req: IncomingMessage, res: ServerResponse) {
		if (!hasToken(req, token)) {
			req.resume();
			return sendJson(res, 401, { error: "unauthorized" });
		}
		if (req.method !== "POST") {
			req.resume();
			return sendJson(res, 405, { error: "method_not_allowed" });
		}
		const body = await readBody(req, MAX_BODY_BYTES);
		if (body === undefined) return sendJson(res, 413, { error: "too_large" });
		let json: unknown;
		try {
			json = JSON.parse(body);
		} catch {
			return sendJson(res, 400, {
				error: "invalid_pick",
				message: "body is not valid json",
			});
		}
		const parsed = pickRequestSchema.safeParse(json);
		if (!parsed.success) {
			return sendJson(res, 400, {
				error: "invalid_pick",
				message: z.prettifyError(parsed.error),
			});
		}
		if (agent.status !== "connected") {
			return sendJson(res, 503, { error: "not_connected" });
		}
		try {
			await agent.send(parsed.data);
		} catch (error) {
			logger.error(
				`[${NAME}] sending pick ${parsed.data.pickId} failed: ${error}`,
			);
			return sendJson(res, 502, { error: "send_failed" });
		}
		sendJson(res, 202, { pickId: parsed.data.pickId, status: "sent" });
	}

	return (req, res, next) => {
		if (req.url?.split("?")[0] !== ENDPOINT) return next();
		handle(req, res).catch(next);
	};
}

function hasToken(req: IncomingMessage, token: string): boolean {
	const given = req.headers["x-ui-pick-token"];
	if (typeof given !== "string") return false;
	// hashing first gives equal-length buffers, so a length mismatch leaks nothing
	const digest = (value: string) => createHash("sha256").update(value).digest();
	return timingSafeEqual(digest(given), digest(token));
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
