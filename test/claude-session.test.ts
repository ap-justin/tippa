import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "vite";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { writeDiscovery } from "../src/channel/discovery.ts";
import {
	type AgentConnection,
	AgentNotConnectedError,
	claudeSession,
} from "../src/index.ts";
import type { AgentStatus, PickReply } from "../src/protocol.ts";

const SECRET = "s".repeat(64);

let root: string;
let fake: Server | undefined;
let connection: AgentConnection | undefined;
let requests: string[];
let warnings: string[];
let statuses: AgentStatus[];
let replies: PickReply[];

const logger = {
	info() {},
	warn: (message: string) => warnings.push(message),
	warnOnce: (message: string) => {
		if (!warnings.includes(message)) warnings.push(message);
	},
	error() {},
	clearScreen() {},
	hasErrorLogged: () => false,
	hasWarned: false,
} satisfies Logger;

/** an http server on the discovered port, answering as `handler` says */
async function serveFake(
	handler: (req: IncomingMessage, res: ServerResponse) => void,
	pid = process.pid,
): Promise<void> {
	fake = createServer((req, res) => {
		requests.push(`${req.method} ${req.url}`);
		handler(req, res);
	});
	await new Promise<void>((resolve) => fake?.listen(0, "127.0.0.1", resolve));
	const { port } = fake.address() as AddressInfo;
	await writeDiscovery(root, { port, secret: SECRET, pid });
}

/** answers like the helper, with `events` driving the sse stream */
function helperLike(events: (res: ServerResponse) => void) {
	return (req: IncomingMessage, res: ServerResponse) => {
		if (req.url === "/health") {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end('{"ok":true}');
		}
		if (req.url === "/events") {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.flushHeaders();
			return events(res);
		}
		res.writeHead(404).end();
	};
}

function connect(): AgentConnection {
	connection = claudeSession().connect({ root, logger });
	connection.onStatus((status) => statuses.push(status));
	connection.onReply((reply) => replies.push(reply));
	return connection;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "tippa-session-"));
	requests = [];
	warnings = [];
	statuses = [];
	replies = [];
});

afterEach(async () => {
	await connection?.close();
	connection = undefined;
	fake?.closeAllConnections();
	await new Promise((resolve) => (fake ? fake.close(resolve) : resolve(null)));
	fake = undefined;
	await rm(root, { recursive: true, force: true });
});

test("a discovery file left by a dead helper is skipped without a request", async () => {
	const gone = spawn(process.execPath, ["-e", ""]);
	await once(gone, "exit");
	await serveFake(
		helperLike(() => {}),
		gone.pid,
	);

	connect();

	await vi.waitFor(() => expect(statuses).toEqual(["waiting"]));
	expect(requests).toEqual([]);
});

test("a reused port answering 200 to everything stays waiting, polled at a bounded rate", async () => {
	await serveFake((_, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		res.end("<!doctype html><p>some other app</p>");
	});

	connect();
	await new Promise((resolve) => setTimeout(resolve, 2500));

	expect(statuses).toEqual(["waiting"]);
	expect(requests.length).toBeLessThanOrEqual(4);
	expect(warnings).toHaveLength(1);
	expect(warnings[0]).toMatch(/tippa/);
});

test("a wrong secret stays waiting and warns once", async () => {
	await serveFake((_, res) => {
		res.writeHead(401, { "content-type": "application/json" });
		res.end('{"error":"missing or wrong x-tippa-secret"}');
	});

	connect();
	await new Promise((resolve) => setTimeout(resolve, 2500));

	expect(statuses).toEqual(["waiting"]);
	expect(warnings).toEqual([expect.stringMatching(/secret/)]);
});

test("a corrupt discovery file warns once and stays waiting", async () => {
	await serveFake(helperLike(() => {}));
	const { writeFile } = await import("node:fs/promises");
	await writeFile(join(root, ".tippa", "channel.json"), "{nope");

	connect();

	await vi.waitFor(() => expect(statuses).toEqual(["waiting"]));
	expect(warnings).toEqual([expect.stringMatching(/channel\.json/)]);
});

test("replies split across chunks, or several in one chunk, arrive whole and in order", async () => {
	let stream: ServerResponse | undefined;
	await serveFake(helperLike((res) => (stream = res)));
	connect();
	await vi.waitFor(() => expect(statuses).toEqual(["connected"]));

	stream?.write('data: {"pickId":"p_1","status":"wor');
	await new Promise((resolve) => setTimeout(resolve, 50));
	stream?.write('king","message":"on it"}\n\n: ping\n\n');
	stream?.write(
		'data: {"pickId":"p_1","status":"done","message":"a"}\n\ndata: {"pickId":"p_2","status":"question","message":"b?"}\n\n',
	);

	await vi.waitFor(() =>
		expect(replies).toEqual([
			{ pickId: "p_1", status: "working", message: "on it" },
			{ pickId: "p_1", status: "done", message: "a" },
			{ pickId: "p_2", status: "question", message: "b?" },
		]),
	);
});

test("when the stream ends the status is waiting at once and send refuses as not connected", async () => {
	let stream: ServerResponse | undefined;
	await serveFake(helperLike((res) => (stream = res)));
	const session = connect();
	await vi.waitFor(() => expect(statuses).toEqual(["connected"]));

	stream?.end();

	await vi.waitFor(() => expect(session.status).toBe("waiting"));
	expect(statuses).toEqual(["connected", "waiting"]);
	await expect(
		session.send({
			pickId: "p_1",
			note: "n",
			component: "C",
			file: "f.tsx",
			line: 1,
			html: "<p></p>",
		}),
	).rejects.toBeInstanceOf(AgentNotConnectedError);
});

const PICK = {
	pickId: "p_1",
	note: "n",
	component: "C",
	file: "f.tsx",
	line: 1,
	html: "<p></p>",
};

test("a helper that stops listening before its stream ends refuses sends as not connected", async () => {
	await serveFake(helperLike(() => {}));
	const session = connect();
	await vi.waitFor(() => expect(statuses).toEqual(["connected"]));

	// the open stream keeps its socket; new connections are refused
	fake?.close();

	await expect(session.send(PICK)).rejects.toBeInstanceOf(
		AgentNotConnectedError,
	);
});

test("a helper that never answers a pick times the send out after 10 s", async () => {
	await serveFake((req, res) => {
		if (req.url === "/pick") return;
		helperLike(() => {})(req, res);
	});
	const session = connect();
	await vi.waitFor(() => expect(statuses).toEqual(["connected"]));
	const timeouts: number[] = [];
	const timer = new AbortController();
	vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
		timeouts.push(ms);
		return timer.signal;
	});

	const sent = session.send(PICK);
	await vi.waitFor(() => expect(requests).toContain("POST /pick"));
	timer.abort(new DOMException("timed out", "TimeoutError"));

	await expect(sent).rejects.toThrow("timed out");
	await expect(sent).rejects.not.toBeInstanceOf(AgentNotConnectedError);
	expect(timeouts).toEqual([10_000]);
});

test("a discovery path that can't be read warns with the error code and stays waiting", async () => {
	await mkdir(join(root, ".tippa", "channel.json"), { recursive: true });

	connect();

	await vi.waitFor(() => expect(statuses).toEqual(["waiting"]));
	expect(warnings).toEqual([expect.stringMatching(/channel\.json: EISDIR/)]);
});

test("a stream that opens and closes at once is re-checked on the poll timer, not in a loop", async () => {
	await serveFake(helperLike((res) => res.end()));

	connect();
	await new Promise((resolve) => setTimeout(resolve, 2500));

	expect(
		requests.filter((r) => r === "GET /events").length,
	).toBeLessThanOrEqual(2);
});

test("closing during a poll stops all further requests and status changes", async () => {
	let answerHealth: (() => void) | undefined;
	await serveFake((req, res) => {
		if (req.url === "/health") {
			answerHealth = () => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end('{"ok":true}');
			};
			return;
		}
		helperLike(() => {})(req, res);
	});

	const session = connect();
	await vi.waitFor(() => expect(answerHealth).toBeDefined());
	await session.close();
	answerHealth?.();
	await new Promise((resolve) => setTimeout(resolve, 2500));

	expect(statuses).toEqual([]);
	expect(requests).toEqual(["GET /health"]);
});
