import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Connect, DevEnvironment, Logger, Plugin } from "vite";
import { z } from "zod";
import {
	type AgentAdapter,
	type AgentConnection,
	AgentNotConnectedError,
} from "./agent.ts";
import { hasSecretHeader, isClientAbort, readBody, sendJson } from "./http.ts";
import {
	type ClientConfig,
	MAX_BODY_BYTES,
	REPLY_EVENT,
	STATUS_EVENT,
	STATUS_REQUEST_EVENT,
} from "./protocol.ts";
import { MAX_HTML_CHARS, pickRequestSchema } from "./schema.ts";

export interface TippaOptions {
	/** the agent picks are sent to, e.g. `claudeSession()` */
	agent: AgentAdapter;
	/** pick hotkey passed to the browser client; defaults to react-grab's */
	key?: string;
}

const NAME = "tippa";
const ENDPOINT = "/__tippa/pick";
// vite's url prefix for files served from outside the root
const FS_PREFIX = "/@fs/";
const LOADER_ID = "virtual:tippa/client";
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

export function tippa(options: TippaOptions): Plugin {
	// keyed by each dev server's client environment: one plugin instance can serve
	// several servers, and a restart opens the new one before closing the old
	const sessions = new WeakMap<object, ServerSession>();
	return {
		name: NAME,
		// vitest, and anything else running vite in test mode, starts a dev server from the app's config; picks have no page there
		apply: (_, env) =>
			env.command === "serve" && env.mode !== "test" && !process.env.VITEST,
		// the session and its token are keyed by the `client` environment alone
		applyToEnvironment: (environment) => environment.name === "client",
		configResolved(config) {
			validate(options);
			if (config.experimental.bundledDev) {
				config.logger.warnOnce(
					`[${NAME}] experimental.bundledDev is on; the tippa client only loads in the default dev mode`,
				);
			}
		},
		configureServer(server) {
			const token = randomBytes(32).toString("hex");
			const { agent } = options;
			const { logger, root } = server.config;
			const client = server.environments.client;
			const hot = client.hot;
			if (isNetworkExposed(server.config.server.host)) {
				logger.warnOnce(
					`[${NAME}] the dev server is exposed on the network; tippa only accepts picks from this machine`,
				);
			}
			const agentConnection = agent.connect({ root, logger });
			sessions.set(client, { token, connection: agentConnection });
			agentConnection.onStatus((status) => {
				logger.info(
					status === "connected"
						? `tippa → connected to ${agent.label}`
						: `tippa → waiting for ${agent.label}`,
				);
				hot.send(STATUS_EVENT, { status });
			});
			agentConnection.onReply((reply) => hot.send(REPLY_EVENT, reply));
			hot.on(STATUS_REQUEST_EVENT, (_, client) =>
				client.send(STATUS_EVENT, { status: agentConnection.status }),
			);
			server.middlewares.use(
				pickEndpoint({
					token,
					root,
					environment: client,
					agent: agentConnection,
					logger,
				}),
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

/** vite binds `localhost` when `server.host` is unset or false */
function isNetworkExposed(host: string | boolean | undefined): boolean {
	if (host === undefined || host === false) return false;
	return host === true || !(host === "localhost" || isLoopback(host));
}

function validate(options: TippaOptions): void {
	const { agent, key } = options ?? {};
	if (typeof agent?.connect !== "function") {
		throw new Error(
			`[${NAME}] options.agent must be an agent adapter, e.g. tippa({ agent: claudeSession() })`,
		);
	}
	if (key !== undefined && (typeof key !== "string" || key.length === 0)) {
		throw new Error(
			`[${NAME}] options.key must be a non-empty string, or omitted for react-grab's default`,
		);
	}
}

/**
 * `POST /__tippa/pick` → 202 `{ pickId, status: "sent" }`, or `{ error }` with
 * 403 `forbidden_address`, 403 `forbidden_forwarded`, 403 `forbidden_origin`, 401 `unauthorized`, 405 `method_not_allowed`, 413 `too_large`, 400 `invalid_pick`,
 * 503 `not_connected`, 502 `send_failed`
 */
function pickEndpoint({
	token,
	root,
	environment,
	agent,
	logger,
}: {
	token: string;
	root: string;
	environment: DevEnvironment;
	agent: AgentConnection;
	logger: Logger;
}): Connect.NextHandleFunction {
	async function handle(req: IncomingMessage, res: ServerResponse) {
		// a network-exposed dev server hands the token to every device that loads the page
		if (!isLoopback(req.socket.remoteAddress)) {
			req.resume();
			return sendJson(res, 403, { error: "forbidden_address" });
		}
		// a tunnel or local reverse proxy connects from loopback on a remote visitor's behalf
		if (FORWARDING_HEADERS.some((header) => header in req.headers)) {
			req.resume();
			return sendJson(res, 403, { error: "forbidden_forwarded" });
		}
		if (!isSameOrigin(req)) {
			req.resume();
			return sendJson(res, 403, { error: "forbidden_origin" });
		}
		if (!hasSecretHeader(req, "x-tippa-token", token)) {
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
		const { moduleUrl, ...pick } = parsed.data;
		const moduleFile =
			moduleUrl === undefined
				? undefined
				: await moduleFilePath(moduleUrl, {
						host: req.headers.host,
						root,
						environment,
					});
		if (moduleUrl !== undefined && moduleFile === undefined) {
			return sendJson(res, 400, {
				error: "invalid_pick",
				message: "moduleUrl is not a module of this dev server",
			});
		}
		const file =
			moduleFile === undefined
				? viteUrlPath(pick.file, root)
				: mapSourcePath(pick.file, moduleFile);
		if (agent.status !== "connected") {
			return sendJson(res, 503, { error: "not_connected" });
		}
		try {
			await agent.send({ ...pick, file });
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
 * a vite url as a file path: root-relative, or `/@fs/<absolute>` outside the root.
 * whoever reads the pick runs elsewhere, so it gets the file's absolute path
 */
function viteUrlPath(url: string, root: string): string {
	const [path = url] = url.split(/[?#]/);
	return servedPathFile(path, root);
}

function servedPathFile(path: string, root: string): string {
	return path.startsWith(FS_PREFIX)
		? path.slice(FS_PREFIX.length - 1)
		: join(root, path);
}

/**
 * the file behind a module url the page loaded, or undefined for another origin,
 * an undecodable path or one climbing out through an encoded `..`
 */
async function moduleFilePath(
	moduleUrl: string,
	{
		host,
		root,
		environment,
	}: { host: string | undefined; root: string; environment: DevEnvironment },
): Promise<string | undefined> {
	let path: string;
	try {
		// the scheme comes from the url itself: the dev server may serve https
		const url = new URL(moduleUrl, `http://${host}`);
		const isPageOrigin =
			url.host === host &&
			(url.protocol === "http:" || url.protocol === "https:");
		if (!isPageOrigin) return undefined;
		path = decodeURIComponent(url.pathname);
	} catch {
		return undefined;
	}
	if (path.split("/").includes("..")) return undefined;
	// the graph keys source modules by path alone; with `?t=` the lookup misses
	const known = await environment.moduleGraph
		.getModuleByUrl(path)
		.catch(() => undefined);
	return known?.file ?? servedPathFile(path, root);
}

/** react-grab passes the map's raw `sources` entry, which vite writes relative to the module's dir */
function mapSourcePath(source: string, moduleFile: string): string {
	let path = source;
	try {
		path = decodeURIComponent(source);
	} catch {}
	return isAbsolute(path) ? path : resolve(dirname(moduleFile), path);
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const FORWARDING_HEADERS = [
	"forwarded",
	"x-forwarded-for",
	"x-real-ip",
	"cf-connecting-ip",
];

function isLoopback(address: string | undefined): boolean {
	return address !== undefined && LOOPBACK_ADDRESSES.has(address);
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
