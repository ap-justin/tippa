import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type Channel, startChannel } from "../src/channel/channel.ts";

let cwd: string;
let channel: Channel;
let client: Client;
let notifications: Notification[];

// 1x1 transparent png
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

interface Discovery {
	port: number;
	secret: string;
	pid: number;
}

async function readDiscovery(): Promise<Discovery> {
	return JSON.parse(
		await readFile(join(cwd, ".ui-pick", "channel.json"), "utf8"),
	);
}

async function post(
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<Response> {
	const { port, secret } = await readDiscovery();
	return fetch(`http://127.0.0.1:${port}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-ui-pick-secret": secret,
			...headers,
		},
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

function pick(overrides: Record<string, unknown> = {}) {
	return {
		pickId: `p_${crypto.randomUUID()}`,
		note: "make this button red",
		component: "SaveButton",
		file: "src/components/SaveButton.tsx",
		line: 12,
		column: 5,
		html: '<button class="save">Save</button>',
		screenshot: PNG_BASE64,
		...overrides,
	};
}

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "ui-pick-test-"));
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	channel = await startChannel({ cwd, transport: serverTransport });
	client = new Client({ name: "test-client", version: "0.0.0" });
	notifications = [];
	client.fallbackNotificationHandler = async (n) => {
		notifications.push(n);
	};
	await client.connect(clientTransport);
});

afterEach(async () => {
	await client.close();
	await channel.close();
	await rm(cwd, { recursive: true, force: true });
});

test("declares the claude/channel capability and a reply tool", async () => {
	expect(client.getServerCapabilities()?.experimental).toEqual({
		"claude/channel": {},
	});
	const { tools } = await client.listTools();
	expect(tools.map((t) => t.name)).toEqual(["reply"]);
});

test("an authed pick emits one channel notification with the pick", async () => {
	const body = pick();
	const res = await post("/pick", body);
	expect(res.status).toBe(202);
	expect(await res.json()).toEqual({ pickId: body.pickId, status: "sent" });

	await vi.waitFor(() => expect(notifications).toHaveLength(1));
	const [event] = notifications;
	expect(event?.method).toBe("notifications/claude/channel");
	const params = event?.params as {
		content: string;
		meta: Record<string, string>;
	};
	expect(params.meta).toEqual({
		pick_id: body.pickId,
		component: "SaveButton",
		file: "src/components/SaveButton.tsx",
		line: "12",
		screenshot: join(tmpdir(), "ui-pick", `${body.pickId}.png`),
	});
	expect(params.content).toContain("make this button red");
	expect(params.content).toContain("SaveButton");
	expect(params.content).toContain("src/components/SaveButton.tsx:12:5");
	expect(params.content).toContain('<button class="save">Save</button>');
	expect(await readFile(params.meta.screenshot as string)).toEqual(
		Buffer.from(PNG_BASE64, "base64"),
	);
});

test.each([
	["missing", undefined],
	["wrong", "0".repeat(64)],
	["wrong-length", "abc"],
])(
	"a pick with a %s secret is refused and emits nothing",
	async (_, secret) => {
		const { port } = await readDiscovery();
		const headers: Record<string, string> = {
			"content-type": "application/json",
		};
		if (secret !== undefined) headers["x-ui-pick-secret"] = secret;
		const res = await fetch(`http://127.0.0.1:${port}/pick`, {
			method: "POST",
			headers,
			body: JSON.stringify(pick()),
		});
		expect(res.status).toBe(401);

		// a later authed pick is the only event, so the refused one never reached claude
		const accepted = pick();
		await post("/pick", accepted);
		await vi.waitFor(() => expect(notifications).toHaveLength(1));
		expect(notifications[0]?.params?.meta).toMatchObject({
			pick_id: accepted.pickId,
		});
	},
);

test.each([
	[
		"a pickId that could escape the tmp dir",
		pick({ pickId: "../x" }),
		"pickId",
	],
	["a pickId over 64 chars", pick({ pickId: "a".repeat(65) }), "pickId"],
	["a missing note", pick({ note: undefined }), "note"],
	["a fractional line", pick({ line: 1.5 }), "line"],
	[
		"a screenshot that is not a png",
		pick({ screenshot: "aGVsbG8=" }),
		"screenshot",
	],
	["a body that is not json", "{nope", "json"],
])("a pick with %s is rejected with a readable 400", async (_, body, field) => {
	const res = await post("/pick", body);
	expect(res.status).toBe(400);
	const { error } = (await res.json()) as { error: string };
	expect(error).toContain(field);

	const accepted = pick();
	await post("/pick", accepted);
	await vi.waitFor(() => expect(notifications).toHaveLength(1));
	expect(notifications[0]?.params?.meta).toMatchObject({
		pick_id: accepted.pickId,
	});
});

test("a pick body over 10 MB is rejected with 413", async () => {
	const res = await post("/pick", pick({ html: "x".repeat(10 * 1024 * 1024) }));
	expect(res.status).toBe(413);
});

async function get(path: string): Promise<Response> {
	const { port, secret } = await readDiscovery();
	return fetch(`http://127.0.0.1:${port}${path}`, {
		headers: { "x-ui-pick-secret": secret },
	});
}

test("health answers ok to an authed caller", async () => {
	const res = await get("/health");
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ ok: true });
});

test("a reply tool call reaches an open events stream", async () => {
	const res = await get("/events");
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toBe("text/event-stream");
	const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();

	const result = await client.callTool({
		name: "reply",
		arguments: { pick_id: "p_1", status: "done", message: "made it red" },
	});
	expect(result.isError).toBeFalsy();

	let received = "";
	while (!received.includes("\n\n", received.indexOf("data:"))) {
		const chunk = await reader?.read();
		if (!chunk || chunk.done) break;
		received += chunk.value;
	}
	await reader?.cancel();
	const data = received
		.split("\n")
		.find((line) => line.startsWith("data: "))
		?.slice("data: ".length);
	expect(JSON.parse(data ?? "null")).toEqual({
		pickId: "p_1",
		status: "done",
		message: "made it red",
	});
});

test("a reply with no browser listening is not an error", async () => {
	const result = await client.callTool({
		name: "reply",
		arguments: { pick_id: "p_1", status: "working", message: "on it" },
	});
	expect(result.isError).toBeFalsy();
});

const discoveryFile = () => join(cwd, ".ui-pick", "channel.json");

test("the discovery file is private to the user and names this process", async () => {
	expect((await stat(discoveryFile())).mode & 0o777).toBe(0o600);
	const discovery = await readDiscovery();
	expect(discovery.pid).toBe(process.pid);
	expect(discovery.secret).toMatch(/^[0-9a-f]{64}$/);
});

test("closing the channel removes its discovery file", async () => {
	await channel.close();
	await expect(access(discoveryFile())).rejects.toThrow("ENOENT");
});

test("closing leaves a newer helper's discovery file in place", async () => {
	const [, serverTransport] = InMemoryTransport.createLinkedPair();
	const newer = await startChannel({ cwd, transport: serverTransport });
	const newerSecret = (await readDiscovery()).secret;

	await channel.close();
	expect((await readDiscovery()).secret).toBe(newerSecret);
	await newer.close();
});
