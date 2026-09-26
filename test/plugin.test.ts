import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import {
	createServer as createHttpServer,
	request as httpRequest,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";
import {
	build,
	createServer,
	type InlineConfig,
	type Logger,
	type Plugin,
	type ViteDevServer,
} from "vite";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type Channel, startChannel } from "../src/channel/channel.ts";
import {
	type Discovery,
	discoveryPath,
	writeDiscovery,
} from "../src/channel/discovery.ts";
import {
	type AgentAdapter,
	AgentNotConnectedError,
	claudeSession,
	tippa,
} from "../src/index.ts";
import type { ClientConfig, PickRequest } from "../src/protocol.ts";

let project: string;
let root: string;
let server: ViteDevServer | undefined;
let helper: Helper | undefined;
let logged: string[];
let problems: string[];

interface Helper {
	channel: Channel;
	client: Client;
	notifications: Notification[];
	stop(): Promise<void>;
}

/** the real channel helper, as claude code would run it from the project root */
async function startHelper(): Promise<Helper> {
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const channel = await startChannel({
		cwd: project,
		transport: serverTransport,
	});
	const client = new Client({ name: "test-client", version: "0.0.0" });
	const notifications: Notification[] = [];
	client.fallbackNotificationHandler = async (n) => {
		notifications.push(n);
	};
	await client.connect(clientTransport);
	const { port, secret } = JSON.parse(
		await readFile(discoveryPath(project), "utf8"),
	) as Discovery;
	await vi.waitFor(async () => {
		const res = await fetch(`http://127.0.0.1:${port}/health`, {
			headers: { "x-tippa-secret": secret },
		});
		expect(res.status).toBe(200);
	});
	return {
		channel,
		client,
		notifications,
		async stop() {
			await client.close();
			await channel.close();
		},
	};
}

const logger: Logger = {
	info: (message) => {
		if (message.startsWith("tippa")) logged.push(message);
	},
	warn: (message) => problems.push(message),
	warnOnce: (message) => problems.push(message),
	error: (message) => problems.push(message),
	clearScreen() {},
	hasErrorLogged: () => false,
	hasWarned: false,
};

/** an agent that never connects, for tests about the page rather than the agent */
const idleAgent: AgentAdapter = {
	label: "Idle",
	connect: () => ({
		status: "waiting",
		onStatus() {},
		send: async () => {},
		close: async () => {},
	}),
};

async function serve(agent: AgentAdapter, key?: string): Promise<string> {
	server = await startServer(
		tippa(key === undefined ? { agent } : { agent, key }),
	);
	return originOf(server);
}

function startServer(
	plugin: Plugin,
	extra: InlineConfig = {},
): Promise<ViteDevServer> {
	return createServer({
		root,
		configFile: false,
		customLogger: logger,
		server: { host: "127.0.0.1", port: 0 },
		plugins: [plugin],
		...extra,
	}).then(async (started) => {
		await started.listen();
		return started;
	});
}

function originOf(started: ViteDevServer): string {
	const address = started.httpServer?.address() as AddressInfo | undefined;
	return `http://127.0.0.1:${address?.port}`;
}

async function getText(url: string): Promise<string> {
	const res = await fetch(url);
	expect(res.status, url).toBe(200);
	return res.text();
}

/** follows the page's own chain: /@vite/client → the tippa loader → its start() config */
async function loadClient(origin: string) {
	const viteClient = await getText(`${origin}/@vite/client`);
	const loaderUrl = viteClient.match(/import\("([^"]*tippa[^"]*)"\)/)?.[1];
	expect(loaderUrl).toBeDefined();
	const loader = await getText(`${origin}${loaderUrl}`);
	const config: ClientConfig = JSON.parse(
		loader.match(/start\((\{.*?\})\)/)?.[1] ?? "null",
	);
	return { config, loader };
}

function postPick(
	origin: string,
	body: unknown,
	headers: Record<string, string>,
): Promise<Response> {
	return fetch(`${origin}/__tippa/pick`, {
		method: "POST",
		// a same-origin browser post carries its own origin
		headers: { "content-type": "application/json", origin, ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

function element(overrides: Record<string, unknown> = {}) {
	return {
		component: "SaveButton",
		file: "/src/components/SaveButton.tsx",
		line: 12,
		html: '<button class="save">Save</button>',
		...overrides,
	};
}

/** a one-element pick; `overrides` are the element's */
function pick(overrides: Record<string, unknown> = {}) {
	return {
		pickId: "p_1",
		note: "make this button red",
		elements: [element(overrides)],
	};
}

function forwardedFiles(sent: PickRequest[]): string[] {
	return sent.flatMap((forwarded) =>
		forwarded.elements.map((each) => each.file),
	);
}

beforeEach(async () => {
	// the plugin stays out of test runners, and this suite runs in one
	vi.stubEnv("VITEST", undefined);
	logged = [];
	problems = [];
	project = await mkdtemp(join(tmpdir(), "tippa-plugin-"));
	root = join(project, "apps", "web");
	await mkdir(root, { recursive: true });
	await writeFile(
		join(root, "index.html"),
		'<!doctype html><html><head></head><body><script type="module" src="/main.js"></script></body></html>',
	);
	await writeFile(join(root, "main.js"), 'document.body.append("app");\n');
});

afterEach(async () => {
	await server?.close();
	server = undefined;
	await helper?.stop();
	helper = undefined;
	await rm(project, { recursive: true, force: true });
});

test.each([
	["no agent", {}, /\[tippa\].*agent/],
	["an agent without connect", { agent: {} }, /\[tippa\].*agent/],
	["an empty key", { agent: claudeSession(), key: "" }, /\[tippa\].*key/],
])(
	"%s fails the dev server at startup, naming the plugin",
	async (_, options, message) => {
		await expect(
			createServer({
				root,
				configFile: false,
				logLevel: "silent",
				plugins: [tippa(options as { agent: AgentAdapter })],
			}),
		).rejects.toThrow(message);
	},
);

test("every served page loads the tippa client and starts it with this server's token", async () => {
	const origin = await serve(idleAgent, "Alt+C");

	// any page with hmr loads /@vite/client, spa or ssr framework alike
	expect(await getText(`${origin}/`)).toContain("/@vite/client");
	const { config, loader } = await loadClient(origin);
	expect(config).toEqual({
		token: expect.stringMatching(/^[0-9a-f]{64}$/),
		endpoint: "/__tippa/pick",
		key: "Alt+C",
	});

	// asked after start() subscribed, so the answer has a listener
	expect(loader.indexOf('send("tippa:status-request")')).toBeGreaterThan(
		loader.indexOf("start("),
	);

	// the client lives in this package, outside the app's workspace root
	const clientUrl = loader.match(/from "(\/@fs\/[^"]+)"/)?.[1];
	expect(clientUrl).toMatch(/\/src\/client\/index\.ts$/);
	expect(await getText(`${origin}${clientUrl}`)).toContain(
		"export function start",
	);
});

test.each([
	["under vitest", () => vi.stubEnv("VITEST", "true"), {}],
	["in test mode", () => {}, { mode: "test" }],
])(
	"%s the plugin stays inert: no agent connection and no client on the page",
	async (_, arrange, extra: InlineConfig) => {
		arrange();
		let connects = 0;
		const counting: AgentAdapter = {
			...idleAgent,
			connect: (context) => {
				connects++;
				return idleAgent.connect(context);
			},
		};
		server = await startServer(tippa({ agent: counting }), extra);

		expect(await getText(`${originOf(server)}/@vite/client`)).not.toContain(
			"virtual:tippa/client",
		);
		expect(connects).toBe(0);
	},
);

test("only the client environment gets the loader, not another client-consumer environment", async () => {
	server = await startServer(tippa({ agent: idleAgent }), {
		environments: { preview: { consumer: "client" } },
	});
	const viteClientIn = async (name: string) =>
		(await server?.environments[name]?.transformRequest("/@vite/client"))?.code;

	expect(await viteClientIn("client")).toContain("virtual:tippa/client");
	expect(await viteClientIn("preview")).not.toContain("virtual:tippa/client");
});

test("a production build carries no tippa plugin, code or strings", async () => {
	let resolvedPlugins: string[] = [];
	const outDir = join(project, "dist");
	await build({
		root,
		configFile: false,
		logLevel: "silent",
		build: { outDir },
		plugins: [
			tippa({ agent: idleAgent }),
			{
				name: "spy",
				configResolved(config) {
					resolvedPlugins = config.plugins.map((plugin) => plugin.name);
				},
			},
		],
	});
	expect(resolvedPlugins).toContain("spy");
	expect(resolvedPlugins).not.toContain("tippa");
	const files = await readdir(outDir, { recursive: true, withFileTypes: true });
	const emitted = files.filter((entry) => entry.isFile());
	expect(emitted.length).toBeGreaterThan(1);
	for (const file of emitted) {
		const text = await readFile(join(file.parentPath, file.name), "utf8");
		expect(text, file.name).not.toMatch(/tippa|tippa|x-tippa-token/);
	}
});

const CONNECTED = "tippa → connected to Claude";
const WAITING = "tippa → waiting for Claude";

test("a vite root nested under the project finds the running helper and connects", async () => {
	helper = await startHelper();
	await serve(claudeSession());
	await vi.waitFor(() => expect(logged).toEqual([CONNECTED]), {
		timeout: 3000,
	});
});

test("a helper started after vite connects, and one that stops puts vite back to waiting", async () => {
	await serve(claudeSession());
	await vi.waitFor(() => expect(logged).toEqual([WAITING]), { timeout: 3000 });

	helper = await startHelper();
	await vi.waitFor(() => expect(logged).toEqual([WAITING, CONNECTED]), {
		timeout: 5000,
	});

	await helper.stop();
	helper = undefined;
	await vi.waitFor(
		() => expect(logged).toEqual([WAITING, CONNECTED, WAITING]),
		{ timeout: 3000 },
	);
});

test("closing the dev server lets go of the helper", async () => {
	helper = await startHelper();
	await serve(claudeSession());
	await vi.waitFor(() => expect(logged).toEqual([CONNECTED]), {
		timeout: 3000,
	});

	await server?.close();
	server = undefined;
	await helper.stop();
	helper = undefined;
	await new Promise((resolve) => setTimeout(resolve, 300));
	expect(logged).toEqual([CONNECTED]);
});

test("a pick posted with the page's token reaches claude with its html cut to 4000 chars", async () => {
	helper = await startHelper();
	const origin = await serve(claudeSession());
	await vi.waitFor(() => expect(logged).toEqual([CONNECTED]), {
		timeout: 3000,
	});
	const { config } = await loadClient(origin);

	const html = `<div>${"x".repeat(5000)}</div>`;
	const res = await postPick(origin, pick({ html }), {
		"x-tippa-token": config.token,
	});

	expect(res.status).toBe(202);
	expect(await res.json()).toEqual({ pickId: "p_1", status: "sent" });
	await vi.waitFor(() => expect(helper?.notifications).toHaveLength(1));
	const content = String(helper?.notifications[0]?.params?.content);
	expect(content).toContain("make this button red");
	expect(content).toContain(html.slice(0, 4000));
	expect(content).not.toContain(html.slice(0, 4001));
});

/** an always-connected agent that keeps what the endpoint forwards */
function recordingAgent(sent: PickRequest[]): AgentAdapter {
	return {
		label: "Recording",
		connect: () => ({
			status: "connected",
			onStatus() {},
			send: async (pick) => {
				sent.push(pick);
			},
			close: async () => {},
		}),
	};
}

test.each([
	[
		"a root-relative url",
		"/src/App.tsx",
		async () => join(await realpath(root), "src", "App.tsx"),
	],
	[
		"a url with query and hash",
		"/src/App.tsx?v=3a1f&import#top",
		async () => join(await realpath(root), "src", "App.tsx"),
	],
	[
		"an /@fs/ url outside the root",
		"/@fs/opt/shared/Button.tsx?t=1",
		async () => "/opt/shared/Button.tsx",
	],
])("%s is forwarded as an absolute file path", async (_, file, expected) => {
	const sent: PickRequest[] = [];
	const origin = await serve(recordingAgent(sent));
	const { config } = await loadClient(origin);

	const res = await postPick(origin, pick({ file }), {
		"x-tippa-token": config.token,
	});

	expect(res.status).toBe(202);
	expect(forwardedFiles(sent)).toEqual([await expected()]);
});

/** a module served as the browser loads it, and what react-grab reads from its inline map */
async function serveModule(origin: string, url: string, file: string) {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, "export const Button = (n: number): number =>\n\tn;\n");
	const code = await getText(`${origin}${url}`);
	const map = JSON.parse(
		Buffer.from(
			code.match(/sourceMappingURL=data:application\/json;base64,(\S+)/)?.[1] ??
				"",
			"base64",
		).toString(),
	) as { sources: [string] };
	return { sourceFile: map.sources[0] };
}

test("a nested module's map-relative source resolves against the module's own dir", async () => {
	const sent: PickRequest[] = [];
	const origin = await serve(recordingAgent(sent));
	const { config } = await loadClient(origin);
	const { sourceFile } = await serveModule(
		origin,
		"/src/ui/Button.tsx",
		join(root, "src", "ui", "Button.tsx"),
	);

	const res = await postPick(
		origin,
		pick({
			file: sourceFile,
			moduleUrl: `${origin}/src/ui/Button.tsx?t=123`,
		}),
		{ "x-tippa-token": config.token },
	);

	expect(res.status).toBe(202);
	expect(forwardedFiles(sent)).toEqual([
		join(await realpath(root), "src", "ui", "Button.tsx"),
	]);
});

test("an absolute source passes through unchanged", async () => {
	const sent: PickRequest[] = [];
	const origin = await serve(recordingAgent(sent));
	const { config } = await loadClient(origin);
	await serveModule(
		origin,
		"/src/ui/Button.tsx",
		join(root, "src", "ui", "Button.tsx"),
	);

	const res = await postPick(
		origin,
		pick({
			file: "/opt/shared/Button.tsx",
			moduleUrl: "/src/ui/Button.tsx",
		}),
		{ "x-tippa-token": config.token },
	);

	expect(res.status).toBe(202);
	expect(forwardedFiles(sent)).toEqual(["/opt/shared/Button.tsx"]);
});

test.each([
	["a raw source", (source: string) => source],
	["an encoded source", encodeURIComponent],
])(
	"a percent-encoded module url with %s resolves to the decoded file path",
	async (_, encodeSource) => {
		const sent: PickRequest[] = [];
		const origin = await serve(recordingAgent(sent));
		const { config } = await loadClient(origin);
		const url = "/src/my%20ui/Save%20Button.tsx";
		const { sourceFile } = await serveModule(
			origin,
			url,
			join(root, "src", "my ui", "Save Button.tsx"),
		);

		const res = await postPick(
			origin,
			pick({
				file: encodeSource(sourceFile),
				moduleUrl: `${origin}${url}?t=1`,
			}),
			{ "x-tippa-token": config.token },
		);

		expect(res.status).toBe(202);
		expect(forwardedFiles(sent)).toEqual([
			join(await realpath(root), "src", "my ui", "Save Button.tsx"),
		]);
	},
);

test("a module served through /@fs/ from outside the root resolves to its own dir", async () => {
	const sent: PickRequest[] = [];
	const projectDir = await realpath(project);
	const shared = join(projectDir, "packages", "ui");
	server = await startServer(tippa({ agent: recordingAgent(sent) }), {
		server: { host: "127.0.0.1", port: 0, fs: { allow: [projectDir] } },
	});
	const origin = originOf(server);
	const { config } = await loadClient(origin);
	const url = `/@fs${shared}/Button.tsx`;
	const { sourceFile } = await serveModule(
		origin,
		url,
		join(shared, "Button.tsx"),
	);

	const res = await postPick(
		origin,
		pick({ file: sourceFile, moduleUrl: `${origin}${url}?t=5` }),
		{ "x-tippa-token": config.token },
	);

	expect(res.status).toBe(202);
	expect(forwardedFiles(sent)).toEqual([join(shared, "Button.tsx")]);
});

test("every element of a multi-element pick is forwarded in order with its own path resolved", async () => {
	const sent: PickRequest[] = [];
	const origin = await serve(recordingAgent(sent));
	const { config } = await loadClient(origin);
	const { sourceFile } = await serveModule(
		origin,
		"/src/ui/Button.tsx",
		join(root, "src", "ui", "Button.tsx"),
	);
	const body = {
		pickId: "p_1",
		note: "put [1] beside [3]",
		elements: [
			element({
				component: "Button",
				file: sourceFile,
				moduleUrl: `${origin}/src/ui/Button.tsx?t=1`,
			}),
			element({ component: "App", file: "/src/App.tsx?v=1" }),
			element({ component: "Shared", file: "/@fs/opt/shared/Card.tsx" }),
		],
	};

	const res = await postPick(origin, body, { "x-tippa-token": config.token });

	expect(res.status).toBe(202);
	const rootDir = await realpath(root);
	expect(sent).toEqual([
		{
			pickId: "p_1",
			note: "put [1] beside [3]",
			elements: [
				{
					...element({ component: "Button" }),
					file: join(rootDir, "src", "ui", "Button.tsx"),
				},
				{
					...element({ component: "App" }),
					file: join(rootDir, "src", "App.tsx"),
				},
				{ ...element({ component: "Shared" }), file: "/opt/shared/Card.tsx" },
			],
		},
	]);
});

test("an element's moduleUrl from another origin is refused with 400 naming that element", async () => {
	const sent: PickRequest[] = [];
	const origin = await serve(recordingAgent(sent));
	const { config } = await loadClient(origin);
	const body = {
		pickId: "p_1",
		note: "",
		elements: [
			element(),
			element({ moduleUrl: "http://evil.test/src/ui/Button.tsx" }),
		],
	};

	const res = await postPick(origin, body, { "x-tippa-token": config.token });

	expect(res.status).toBe(400);
	expect(await res.json()).toEqual({
		error: "invalid_pick",
		message: "elements[1].moduleUrl is not a module of this dev server",
	});
	expect(sent).toEqual([]);
});

test.each([
	["another origin", "http://evil.test/src/ui/Button.tsx"],
	[
		"an encoded .. climbing out of the root",
		"/src/..%2F..%2F..%2Fetc/Button.tsx",
	],
	["a non-http scheme", "file:///src/ui/Button.tsx"],
	["an overlong url", `/src/${"a".repeat(2048)}.tsx`],
])(
	"a moduleUrl from %s is refused with 400 and never forwarded",
	async (_, moduleUrl) => {
		const sent: PickRequest[] = [];
		const origin = await serve(recordingAgent(sent));
		const { config } = await loadClient(origin);

		const res = await postPick(
			origin,
			pick({ file: "Button.tsx", moduleUrl }),
			{
				"x-tippa-token": config.token,
			},
		);

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: "invalid_pick" });
		expect(sent).toEqual([]);
	},
);

test("claude at the project root reads a nested vite root's file relative to itself", async () => {
	helper = await startHelper();
	const origin = await serve(claudeSession());
	await vi.waitFor(() => expect(logged).toEqual([CONNECTED]), {
		timeout: 3000,
	});
	const { config } = await loadClient(origin);
	const { sourceFile } = await serveModule(
		origin,
		"/src/ui/Button.tsx",
		join(root, "src", "ui", "Button.tsx"),
	);

	await postPick(
		origin,
		pick({
			file: sourceFile,
			moduleUrl: `${origin}/src/ui/Button.tsx?t=1`,
			line: 7,
		}),
		{ "x-tippa-token": config.token },
	);

	await vi.waitFor(() => expect(helper?.notifications).toHaveLength(1));
	const params = helper?.notifications[0]?.params as {
		content: string;
		meta: Record<string, string>;
	};
	expect(params.content).toContain("source: apps/web/src/ui/Button.tsx:7\n");
});

test.each([
	["no token", {}],
	["a wrong token", { "x-tippa-token": "0".repeat(64) }],
])(
	"a pick with %s is refused with 401 and never forwarded",
	async (_, headers) => {
		helper = await startHelper();
		const origin = await serve(claudeSession());
		await vi.waitFor(() => expect(logged).toEqual([CONNECTED]), {
			timeout: 3000,
		});

		const res = await postPick(origin, pick(), headers);

		expect(res.status).toBe(401);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(helper.notifications).toEqual([]);
	},
);

test("a pick while claude isn't connected answers 503 not_connected", async () => {
	const origin = await serve(claudeSession());
	await vi.waitFor(() => expect(logged).toEqual([WAITING]), { timeout: 3000 });
	const { config } = await loadClient(origin);

	const res = await postPick(origin, pick(), {
		"x-tippa-token": config.token,
	});

	expect(res.status).toBe(503);
	expect(await res.json()).toEqual({ error: "not_connected" });
});

test.each([
	["over 10 MB", pick({ html: "x".repeat(10 * 1024 * 1024) }), 413],
	["not json", "{", 400],
	["missing fields", { pickId: "p_1" }, 400],
	["with a screenshot that isn't a png", pick({ screenshot: "aGVsbG8=" }), 400],
])(
	"a pick body %s is refused before the agent sees it",
	async (_, body, status) => {
		const origin = await serve(idleAgent);
		const { config } = await loadClient(origin);

		const res = await postPick(origin, body, {
			"x-tippa-token": config.token,
		});

		expect(res.status).toBe(status);
		expect(await res.json()).toHaveProperty("error");
	},
);

/** a browser's hmr socket to the dev server, collecting tippa's custom events */
async function openHmrSocket(origin: string) {
	const ws = new WebSocket(
		`${origin.replace("http", "ws")}/?token=${server?.config.webSocketToken}`,
		"vite-hmr",
	);
	const received: { event: string; data: unknown }[] = [];
	ws.addEventListener("message", (message) => {
		const payload = JSON.parse(String(message.data));
		if (payload.type === "custom" && payload.event.startsWith("tippa:")) {
			received.push({ event: payload.event, data: payload.data });
		}
	});
	await new Promise((resolve, reject) => {
		ws.addEventListener("open", resolve);
		ws.addEventListener("error", reject);
	});
	return {
		received,
		send: (event: string) =>
			ws.send(JSON.stringify({ type: "custom", event, data: undefined })),
		close: () => ws.close(),
	};
}

test("a browser that connects late learns the current status by asking", async () => {
	helper = await startHelper();
	const origin = await serve(claudeSession());
	await vi.waitFor(() => expect(logged).toEqual([CONNECTED]), {
		timeout: 3000,
	});
	const socket = await openHmrSocket(origin);

	socket.send("tippa:status-request");

	await vi.waitFor(() =>
		expect(socket.received).toEqual([
			{ event: "tippa:status", data: { status: "connected" } },
		]),
	);
	socket.close();
});

test("status changes are pushed to open pages", async () => {
	helper = await startHelper();
	const origin = await serve(claudeSession());
	await vi.waitFor(() => expect(logged).toEqual([CONNECTED]), {
		timeout: 3000,
	});
	const socket = await openHmrSocket(origin);

	await helper.stop();
	helper = undefined;

	await vi.waitFor(() =>
		expect(socket.received).toEqual([
			{ event: "tippa:status", data: { status: "waiting" } },
		]),
	);
	socket.close();
});

test.each([
	["another localhost port's origin", { origin: "http://127.0.0.1:1" }],
	["a cross-site fetch", { origin: undefined, "sec-fetch-site": "cross-site" }],
	["a same-site fetch from another port", { "sec-fetch-site": "same-site" }],
	["no origin at all", { origin: undefined }],
])(
	"a pick from %s is refused with 403 even with the token",
	async (_, headers) => {
		helper = await startHelper();
		const origin = await serve(claudeSession());
		await vi.waitFor(() => expect(logged).toEqual([CONNECTED]), {
			timeout: 3000,
		});
		const { config } = await loadClient(origin);

		const res = await fetch(`${origin}/__tippa/pick`, {
			method: "POST",
			headers: Object.fromEntries(
				Object.entries({
					"content-type": "application/json",
					origin,
					"x-tippa-token": config.token,
					...headers,
				}).filter((entry): entry is [string, string] => entry[1] !== undefined),
			),
			body: JSON.stringify(pick()),
		});

		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "forbidden_origin" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(helper.notifications).toEqual([]);
	},
);

const lanAddress = Object.values(networkInterfaces())
	.flat()
	.find(
		(iface) => iface && !iface.internal && iface.family === "IPv4",
	)?.address;

test.skipIf(!lanAddress)(
	"on a network-exposed dev server, a pick from another address is refused with 403 even with the token",
	async () => {
		const sent: PickRequest[] = [];
		server = await startServer(tippa({ agent: recordingAgent(sent) }), {
			server: { host: "0.0.0.0", port: 0 },
		});
		const { port } = new URL(originOf(server));
		const lanOrigin = `http://${lanAddress}:${port}`;
		const { config } = await loadClient(lanOrigin);

		const fromLan = await postPick(lanOrigin, pick(), {
			"x-tippa-token": config.token,
		});
		expect(fromLan.status).toBe(403);
		expect(await fromLan.json()).toEqual({ error: "forbidden_address" });
		expect(sent).toEqual([]);

		const loopbackOrigin = `http://127.0.0.1:${port}`;
		const fromLoopback = await postPick(loopbackOrigin, pick(), {
			"x-tippa-token": config.token,
		});
		expect(fromLoopback.status).toBe(202);
		expect(problems).toContainEqual(
			expect.stringMatching(/tippa.*only accepts picks from this machine/),
		);
	},
);

test.each([
	["forwarded", "for=203.0.113.7"],
	["x-forwarded-for", "203.0.113.7"],
	["x-real-ip", "203.0.113.7"],
	["cf-connecting-ip", "203.0.113.7"],
])(
	"a pick relayed by a tunnel or proxy (%s) is refused with 403 though its socket is loopback",
	async (header, value) => {
		const sent: PickRequest[] = [];
		const origin = await serve(recordingAgent(sent));
		const { config } = await loadClient(origin);

		const res = await postPick(origin, pick(), {
			"x-tippa-token": config.token,
			[header]: value,
		});

		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "forbidden_forwarded" });
		expect(sent).toEqual([]);
	},
);

test("a same-origin browser post passes on sec-fetch-site alone", async () => {
	const origin = await serve(idleAgent);
	const { config } = await loadClient(origin);

	const res = await postPick(origin, pick(), {
		origin: "http://ignored.example",
		"sec-fetch-site": "same-origin",
		"x-tippa-token": config.token,
	});

	// past the origin gate: the idle agent isn't connected
	expect(res.status).toBe(503);
});

/**
 * a fake helper at the project root: healthy, streaming, with `/pick` answered by `onPick`
 * and each opened events stream handed to `onEvents`
 */
async function serveFakeHelper(
	onPick: (res: ServerResponse) => void,
	onEvents: (res: ServerResponse) => void = () => {},
): Promise<() => Promise<void>> {
	const secret = "s".repeat(64);
	const fake = createHttpServer((req, res) => {
		if (req.url === "/health") return res.end('{"ok":true}');
		if (req.url === "/events") {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.flushHeaders();
			return onEvents(res);
		}
		req.resume();
		onPick(res);
	});
	await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
	const { port } = fake.address() as AddressInfo;
	await writeDiscovery(project, { port, secret, pid: process.pid });
	return async () => {
		fake.closeAllConnections();
		await new Promise((resolve) => fake.close(resolve));
	};
}

test("a helper that fails the pick answers 502 send_failed and logs why", async () => {
	const stopFake = await serveFakeHelper((res) => {
		res.writeHead(500).end("boom");
	});
	try {
		const origin = await serve(claudeSession());
		await vi.waitFor(() => expect(logged).toEqual([CONNECTED]), {
			timeout: 3000,
		});
		const { config } = await loadClient(origin);

		const res = await postPick(origin, pick(), {
			"x-tippa-token": config.token,
		});

		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: "send_failed" });
		expect(problems).toEqual([expect.stringMatching(/p_1.*500/)]);
	} finally {
		await server?.close();
		server = undefined;
		await stopFake();
	}
});

test("data on the helper's events stream never reaches the browser", async () => {
	let stream: ServerResponse | undefined;
	const stopFake = await serveFakeHelper(
		(res) => res.writeHead(404).end(),
		(res) => {
			stream ??= res;
		},
	);
	try {
		const origin = await serve(claudeSession());
		await vi.waitFor(() => expect(logged).toEqual([CONNECTED]), {
			timeout: 3000,
		});
		const socket = await openHmrSocket(origin);

		stream?.write(
			`data: ${JSON.stringify({ pickId: "p_1", status: "done", message: "made it red" })}\n\n`,
		);
		stream?.end();

		await vi.waitFor(() => expect(logged).toEqual([CONNECTED, WAITING]));
		await vi.waitFor(() =>
			expect(socket.received).toEqual([
				{ event: "tippa:status", data: { status: "waiting" } },
			]),
		);
		socket.close();
	} finally {
		await server?.close();
		server = undefined;
		await stopFake();
	}
});

test("a send refused as not connected answers 503, not 502", async () => {
	const racing: AgentAdapter = {
		label: "Racing",
		connect: () => ({
			status: "connected",
			onStatus() {},
			send: async () => {
				throw new AgentNotConnectedError("Racing");
			},
			close: async () => {},
		}),
	};
	const origin = await serve(racing);
	const { config } = await loadClient(origin);

	const res = await postPick(origin, pick(), {
		"x-tippa-token": config.token,
	});

	expect(res.status).toBe(503);
	expect(await res.json()).toEqual({ error: "not_connected" });
});

test("one plugin instance shared by two dev servers keeps each server's connection", async () => {
	helper = await startHelper();
	const plugin = tippa({ agent: claudeSession() });
	const firstLogged: string[] = [];
	const first = await startServer(plugin, {
		customLogger: {
			...logger,
			info: (message) => {
				if (message.startsWith("tippa")) firstLogged.push(message);
			},
		},
	});
	server = await startServer(plugin);
	await vi.waitFor(
		() => {
			expect(firstLogged).toEqual([CONNECTED]);
			expect(logged).toEqual([CONNECTED]);
		},
		{ timeout: 3000 },
	);

	await first.close();
	const { config } = await loadClient(originOf(server));
	const res = await postPick(originOf(server), pick(), {
		"x-tippa-token": config.token,
	});
	expect(res.status).toBe(202);

	await helper.stop();
	helper = undefined;
	await vi.waitFor(() => expect(logged).toEqual([CONNECTED, WAITING]));
	// the closed server's connection went with it
	expect(firstLogged).toEqual([CONNECTED]);
});

test("a browser that aborts mid-upload is dropped without an error", async () => {
	const origin = await serve(idleAgent);
	const { config } = await loadClient(origin);
	const { port } = new URL(origin);

	const upload = httpRequest({
		host: "127.0.0.1",
		port,
		method: "POST",
		path: "/__tippa/pick",
		headers: {
			origin,
			"x-tippa-token": config.token,
			"content-type": "application/json",
			"content-length": String(5 * 1024 * 1024),
		},
	});
	upload.on("error", () => {});
	upload.write("x".repeat(1024 * 1024));
	await new Promise((resolve) => setTimeout(resolve, 100));
	upload.destroy();
	await new Promise((resolve) => setTimeout(resolve, 200));

	expect(problems).toEqual([]);
});

test("experimental bundled dev warns that the client won't load", async () => {
	server = await startServer(tippa({ agent: idleAgent }), {
		experimental: { bundledDev: true },
	});
	expect(problems).toEqual([expect.stringMatching(/tippa.*bundledDev/)]);
});
