import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Connect, Logger, Plugin } from "vite";
import { z } from "zod";
import {
	type AgentAdapter,
	type AgentConnection,
	AgentNotConnectedError,
} from "./agent.ts";
import { hasSecretHeader, isClientAbort, readBody, sendJson } from "./http.ts";
import {
	type ClientConfig,
	REPLY_EVENT,
	STATUS_EVENT,
	STATUS_REQUEST_EVENT,
} from "./protocol.ts";
import { MAX_HTML_CHARS, pickRequestSchema } from "./schema.ts";

export interface UiPickOptions {
	/** the agent picks are sent to, e.g. `claudeSession()` */
	agent: AgentAdapter;
	/** pick hotkey passed to the browser client; defaults to react-grab's */
	key?: string;
}

const NAME = "ui-pick";
const ENDPOINT = "/__ui-pick/pick";
const MAX_BODY_BYTES = 10 * 1024 * 1024;
// vite's url prefix for files served from outside the root
const FS_PREFIX = "/@fs/";
const LOADER_ID = "virtual:ui-pick/client";
const RESOLVED_LOADER_ID = `\0${LOADER_ID}`;
// extensionless so vite's resolver finds src/client/index.ts and dist/client/index.js alike
const CLIENT_ENTRY = fileURLToPath(new URL("./client/index", import.meta.url));

const truncatedPickSchema = pickRequestSchema.extend({
	html: z.string().transform((html) => html.slice(0, MAX_HTML_CHARS)),
});

interface ServerSession {
	token: string;
	connection: AgentConnection;
}

export function uiPick(options: UiPickOptions): Plugin {
	// keyed by each dev server's client environment: one plugin instance can serve
	// several servers, and a restart opens the new one before closing the old
	const sessions = new WeakMap<object, ServerSession>();
	return {
		name: NAME,
		apply: "serve",
		applyToEnvironment: (environment) =>
			environment.config.consumer === "client",
		configResolved(config) {
			validate(options);
			if (config.experimental.bundledDev) {
				config.logger.warnOnce(
					`[${NAME}] experimental.bundledDev is on; the ui-pick client only loads in the default dev mode`,
				);
			}
		},
		configureServer(server) {
			const token = randomBytes(32).toString("hex");
			const { agent } = options;
			const { logger, root } = server.config;
			const client = server.environments.client;
			const hot = client.hot;
			const agentConnection = agent.connect({ root, logger });
			sessions.set(client, { token, connection: agentConnection });
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
			server.middlewares.use(
				pickEndpoint({ token, root, agent: agentConnection, logger }),
			);
		},
		async buildEnd() {
			await sessions.get(this.environment)?.connection.close();
			sessions.delete(this.environment);
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
				const session = sessions.get(this.environment);
				if (!session) return null;
				const config: ClientConfig = {
					token: session.token,
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
 * 403 `forbidden_origin`, 401 `unauthorized`, 405 `method_not_allowed`, 413 `too_large`, 400 `invalid_pick`,
 * 503 `not_connected`, 502 `send_failed`
 */
function pickEndpoint({
	token,
	root,
	agent,
	logger,
}: {
	token: string;
	root: string;
	agent: AgentConnection;
	logger: Logger;
}): Connect.NextHandleFunction {
	async function handle(req: IncomingMessage, res: ServerResponse) {
		if (!isSameOrigin(req)) {
			req.resume();
			return sendJson(res, 403, { error: "forbidden_origin" });
		}
		if (!hasSecretHeader(req, "x-ui-pick-token", token)) {
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
		const parsed = truncatedPickSchema.safeParse(json);
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
			await agent.send({
				...parsed.data,
				file: sourcePath(parsed.data.file, root),
			});
		} catch (error) {
			if (error instanceof AgentNotConnectedError) {
				return sendJson(res, 503, { error: "not_connected" });
			}
			logger.error(
				`[${NAME}] sending pick ${parsed.data.pickId} failed: ${error}`,
			);
			return sendJson(res, 502, { error: "send_failed" });
		}
		sendJson(res, 202, { pickId: parsed.data.pickId, status: "sent" });
	}

	return (req, res, next) => {
		if (req.url?.split("?")[0] !== ENDPOINT) return next();
		handle(req, res).catch((error: unknown) => {
			if (!isClientAbort(req)) next(error);
		});
	};
}

/**
 * react-grab reports vite urls: root-relative, or `/@fs/<absolute>` outside the root.
 * whoever reads the pick runs elsewhere, so it gets the file's absolute path
 */
function sourcePath(url: string, root: string): string {
	const [path = url] = url.split(/[?#]/);
	return path.startsWith(FS_PREFIX)
		? path.slice(FS_PREFIX.length - 1)
		: join(root, path);
}

/**
 * vite's default cors admits every localhost origin, so another local page could read
 * the token from the loader; only the page's own origin may post
 */
function isSameOrigin(req: IncomingMessage): boolean {
	const site = req.headers["sec-fetch-site"];
	if (site !== undefined) return site === "same-origin";
	const { origin, host } = req.headers;
	if (origin === undefined || host === undefined) return false;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}
