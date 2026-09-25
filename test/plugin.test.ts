import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";
import { build, createServer, type Logger, type ViteDevServer } from "vite";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type Channel, startChannel } from "../src/channel/channel.ts";
import { type AgentAdapter, claudeSession, uiPick } from "../src/index.ts";
import type { ClientConfig } from "../src/protocol.ts";

let project: string;
let root: string;
let server: ViteDevServer | undefined;
let helper: Helper | undefined;
let logged: string[];

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
		if (message.startsWith("ui-pick")) logged.push(message);
	},
	warn() {},
	warnOnce() {},
	error() {},
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
		onReply() {},
		send: async () => {},
		close: async () => {},
	}),
};

async function serve(agent: AgentAdapter, key?: string): Promise<string> {
	server = await createServer({
		root,
		configFile: false,
		customLogger: logger,
		server: { host: "127.0.0.1", port: 0 },
		plugins: [uiPick(key === undefined ? { agent } : { agent, key })],
	});
	await server.listen();
	const { port } = server.httpServer!.address() as AddressInfo;
	return `http://127.0.0.1:${port}`;
}

async function getText(url: string): Promise<string> {
	const res = await fetch(url);
	expect(res.status, url).toBe(200);
	return res.text();
}

/** follows the page's own chain: /@vite/client → the ui-pick loader → its start() config */
async function loadClient(origin: string) {
	const viteClient = await getText(`${origin}/@vite/client`);
	const loaderUrl = viteClient.match(/import\("([^"]*ui-pick[^"]*)"\)/)?.[1];
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
	return fetch(`${origin}/__ui-pick/pick`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

function pick(overrides: Record<string, unknown> = {}) {
	return {
		pickId: "p_1",
		note: "make this button red",
		component: "SaveButton",
		file: "src/components/SaveButton.tsx",
		line: 12,
		html: '<button class="save">Save</button>',
		...overrides,
	};
}

beforeEach(async () => {
	logged = [];
	project = await mkdtemp(join(tmpdir(), "ui-pick-plugin-"));
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
	["no agent", {}, /\[ui-pick\].*agent/],
	["an agent without connect", { agent: {} }, /\[ui-pick\].*agent/],
	["an empty key", { agent: claudeSession(), key: "" }, /\[ui-pick\].*key/],
])(
	"%s fails the dev server at startup, naming the plugin",
	async (_, options, message) => {
		await expect(
			createServer({
				root,
				configFile: false,
				logLevel: "silent",
				plugins: [uiPick(options as { agent: AgentAdapter })],
			}),
		).rejects.toThrow(message);
	},
);

test("every served page loads the ui-pick client and starts it with this server's token", async () => {
	const origin = await serve(idleAgent, "Alt+C");

	// any page with hmr loads /@vite/client, spa or ssr framework alike
	expect(await getText(`${origin}/`)).toContain("/@vite/client");
	const { config, loader } = await loadClient(origin);
	expect(config).toEqual({
		token: expect.stringMatching(/^[0-9a-f]{64}$/),
		endpoint: "/__ui-pick/pick",
		key: "Alt+C",
	});

	// asked after start() subscribed, so the answer has a listener
	expect(loader.indexOf('send("ui-pick:status-request")')).toBeGreaterThan(
		loader.indexOf("start("),
	);

	// the client lives in this package, outside the app's workspace root
	const clientUrl = loader.match(/from "(\/@fs\/[^"]+)"/)?.[1];
	expect(clientUrl).toMatch(/\/src\/client\/index\.ts$/);
	expect(await getText(`${origin}${clientUrl}`)).toContain(
		"export function start",
	);
});

test("a production build carries no ui-pick code or strings", async () => {
	const outDir = join(project, "dist");
	await build({
		root,
		configFile: false,
		logLevel: "silent",
		build: { outDir },
		plugins: [uiPick({ agent: idleAgent })],
	});
	const files = await readdir(outDir, { recursive: true, withFileTypes: true });
	const emitted = files.filter((entry) => entry.isFile());
	expect(emitted.length).toBeGreaterThan(1);
	for (const file of emitted) {
		const text = await readFile(join(file.parentPath, file.name), "utf8");
		expect(text, file.name).not.toMatch(/ui-pick|uiPick|x-ui-pick-token/);
	}
});

const CONNECTED = "ui-pick → connected to Claude";
const WAITING = "ui-pick → waiting for Claude";

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
		"x-ui-pick-token": config.token,
	});

	expect(res.status).toBe(202);
	expect(await res.json()).toEqual({ pickId: "p_1", status: "sent" });
	await vi.waitFor(() => expect(helper?.notifications).toHaveLength(1));
	const content = String(helper?.notifications[0]?.params?.content);
	expect(content).toContain("make this button red");
	expect(content).toContain(html.slice(0, 4000));
	expect(content).not.toContain(html.slice(0, 4001));
});

test.each([
	["no token", {}],
	["a wrong token", { "x-ui-pick-token": "0".repeat(64) }],
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
		"x-ui-pick-token": config.token,
	});

	expect(res.status).toBe(503);
	expect(await res.json()).toEqual({ error: "not_connected" });
});

test.each([
	["over 10 MB", pick({ html: "x".repeat(10 * 1024 * 1024) }), 413],
	["not json", "{", 400],
	["missing fields", { pickId: "p_1" }, 400],
])(
	"a pick body %s is refused before the agent sees it",
	async (_, body, status) => {
		const origin = await serve(idleAgent);
		const { config } = await loadClient(origin);

		const res = await postPick(origin, body, {
			"x-ui-pick-token": config.token,
		});

		expect(res.status).toBe(status);
		expect(await res.json()).toHaveProperty("error");
	},
);

/** a browser's hmr socket to the dev server, collecting ui-pick's custom events */
async function openHmrSocket(origin: string) {
	const ws = new WebSocket(
		`${origin.replace("http", "ws")}/?token=${server?.config.webSocketToken}`,
		"vite-hmr",
	);
	const received: { event: string; data: unknown }[] = [];
	ws.addEventListener("message", (message) => {
		const payload = JSON.parse(String(message.data));
		if (payload.type === "custom" && payload.event.startsWith("ui-pick:")) {
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

test("claude's reply reaches the browser as a ui-pick:reply hmr event", async () => {
	helper = await startHelper();
	const origin = await serve(claudeSession());
	await vi.waitFor(() => expect(logged).toEqual([CONNECTED]), {
		timeout: 3000,
	});
	const socket = await openHmrSocket(origin);

	await helper.client.callTool({
		name: "reply",
		arguments: { pick_id: "p_1", status: "done", message: "made it red" },
	});

	await vi.waitFor(() =>
		expect(socket.received).toContainEqual({
			event: "ui-pick:reply",
			data: { pickId: "p_1", status: "done", message: "made it red" },
		}),
	);
	socket.close();
});

test("a browser that connects late learns the current status by asking", async () => {
	helper = await startHelper();
	const origin = await serve(claudeSession());
	await vi.waitFor(() => expect(logged).toEqual([CONNECTED]), {
		timeout: 3000,
	});
	const socket = await openHmrSocket(origin);

	socket.send("ui-pick:status-request");

	await vi.waitFor(() =>
		expect(socket.received).toEqual([
			{ event: "ui-pick:status", data: { status: "connected" } },
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
			{ event: "ui-pick:status", data: { status: "waiting" } },
		]),
	);
	socket.close();
});
