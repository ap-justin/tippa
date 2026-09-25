import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "vite";
import { z } from "zod";
import {
	type AgentAdapter,
	type AgentConnection,
	AgentNotConnectedError,
} from "./agent.ts";
import { type Discovery, discoveryPath } from "./channel/discovery.ts";
import type { AgentStatus, PickReply, PickRequest } from "./protocol.ts";

const LABEL = "Claude";
const POLL_MS = 2000;
const SEND_TIMEOUT_MS = 10_000;

const discoverySchema = z.object({
	port: z.number().int().positive(),
	secret: z.string().min(1),
	pid: z.number().int().positive(),
});

const healthSchema = z.object({ ok: z.literal(true) });

const replySchema = z.object({
	pickId: z.string(),
	status: z.enum(["working", "done", "question"]),
	message: z.string(),
});

/**
 * sends picks to the claude code session running the `ui-pick-channel` helper.
 * finds the helper through the nearest `.ui-pick/channel.json` at or above vite's root.
 */
export function claudeSession(): AgentAdapter {
	return {
		label: LABEL,
		connect: ({ root, logger }) => connectToHelper(root, logger),
	};
}

/** why a check found no helper; logged once per distinct text */
class NoHelper {
	constructor(readonly reason?: string) {}
}

function connectToHelper(root: string, logger: Logger): AgentConnection {
	const statusListeners = new Set<(status: AgentStatus) => void>();
	const replyListeners = new Set<(reply: PickReply) => void>();
	let status: AgentStatus = "waiting";
	let announced = false;
	let helper: Discovery | undefined;
	let inFlight: AbortController | undefined;
	let timer: NodeJS.Timeout | undefined;
	let closed = false;

	function setStatus(next: AgentStatus): void {
		if (announced && next === status) return;
		announced = true;
		status = next;
		for (const listener of statusListeners) listener(next);
	}

	function wait(): void {
		helper = undefined;
		inFlight = undefined;
		setStatus("waiting");
		timer = setTimeout(check, POLL_MS).unref();
	}

	async function check(): Promise<void> {
		const controller = new AbortController();
		inFlight = controller;
		const result = await findDiscovery(root)
			.then((found) =>
				found instanceof NoHelper ? found : open(found, controller.signal),
			)
			.catch((error: unknown) =>
				controller.signal.aborted
					? new NoHelper()
					: new NoHelper(`helper request failed: ${error}`),
			);
		if (closed) {
			controller.abort();
			return;
		}
		if (result instanceof NoHelper) {
			if (result.reason) logger.warnOnce(`ui-pick: ${result.reason}`);
			return wait();
		}
		helper = result.discovery;
		setStatus("connected");
		void readReplies(result.stream, emitReply).then(() => {
			if (!closed) wait();
		});
	}

	function emitReply(reply: PickReply): void {
		for (const listener of replyListeners) listener(reply);
	}

	void check();

	return {
		get status() {
			return status;
		},
		onStatus(listener) {
			statusListeners.add(listener);
		},
		onReply(listener) {
			replyListeners.add(listener);
		},
		async send(pick: PickRequest) {
			const target = helper;
			if (!target) throw new AgentNotConnectedError(LABEL);
			const res = await fetch(helperUrl(target, "/pick"), {
				method: "POST",
				headers: { ...auth(target), "content-type": "application/json" },
				body: JSON.stringify(pick),
				signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
			});
			const body = await res.text();
			if (res.status !== 202) {
				throw new Error(`helper refused the pick (${res.status}): ${body}`);
			}
		},
		async close() {
			closed = true;
			clearTimeout(timer);
			inFlight?.abort();
		},
	};
}

/**
 * checks the port answers as the helper, then opens its reply stream.
 * `signal` aborts both, and stays attached to the stream for close()
 */
async function open(
	found: Discovery,
	signal: AbortSignal,
): Promise<
	{ discovery: Discovery; stream: ReadableStream<Uint8Array> } | NoHelper
> {
	const health = await fetch(helperUrl(found, "/health"), {
		headers: auth(found),
		signal: AbortSignal.any([signal, AbortSignal.timeout(POLL_MS)]),
	});
	const healthBody = await health.text();
	if (health.status === 401) {
		return new NoHelper(
			"the helper refused channel.json's secret; is another project's helper on that port?",
		);
	}
	// 503: claude hasn't finished its handshake yet; the next poll will see it
	if (health.status === 503) return new NoHelper();
	if (!health.ok || !isHealthy(healthBody)) {
		return new NoHelper(
			`port ${found.port} from channel.json doesn't answer as the helper; waiting for a fresh one`,
		);
	}

	// headers must arrive within POLL_MS; the stream itself stays open until the helper ends it
	const headers = new AbortController();
	const headerTimer = setTimeout(() => headers.abort(), POLL_MS);
	const events = await fetch(helperUrl(found, "/events"), {
		headers: auth(found),
		signal: AbortSignal.any([signal, headers.signal]),
	}).finally(() => clearTimeout(headerTimer));
	const isStream = events.headers
		.get("content-type")
		?.startsWith("text/event-stream");
	if (!events.ok || !isStream || !events.body) {
		await events.body?.cancel();
		return new NoHelper(
			`port ${found.port} from channel.json doesn't stream as the helper; waiting for a fresh one`,
		);
	}
	return { discovery: found, stream: events.body };
}

/** the nearest discovery file wins; one whose helper process is gone is skipped */
async function findDiscovery(root: string): Promise<Discovery | NoHelper> {
	for (let dir = root; ; dir = dirname(dir)) {
		const path = discoveryPath(dir);
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch (error) {
			const { code } = error as NodeJS.ErrnoException;
			if (code !== "ENOENT") return new NoHelper(`can't read ${path}: ${code}`);
			if (dirname(dir) === dir) return new NoHelper();
			continue;
		}
		let parsed: Discovery;
		try {
			parsed = discoverySchema.parse(JSON.parse(text));
		} catch {
			return new NoHelper(`${path} is not a valid channel.json`);
		}
		if (isAlive(parsed.pid)) return parsed;
		if (dirname(dir) === dir) return new NoHelper();
	}
}

function isHealthy(body: string): boolean {
	try {
		return healthSchema.safeParse(JSON.parse(body)).success;
	} catch {
		return false;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: alive, owned by another user
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function helperUrl({ port }: Discovery, path: string): string {
	return `http://127.0.0.1:${port}${path}`;
}

function auth({ secret }: Discovery): Record<string, string> {
	return { "x-ui-pick-secret": secret };
}

/** reads the helper's `data: <json>` events until the stream ends or is aborted */
async function readReplies(
	stream: ReadableStream<Uint8Array>,
	emit: (reply: PickReply) => void,
): Promise<void> {
	let buffer = "";
	try {
		for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
			buffer += chunk;
			const events = buffer.split("\n\n");
			buffer = events.pop() ?? "";
			for (const event of events) {
				const data = event
					.split("\n")
					.filter((line) => line.startsWith("data: "))
					.map((line) => line.slice("data: ".length))
					.join("\n");
				const reply = parseReply(data);
				if (reply) emit(reply);
			}
		}
	} catch {
		// the helper went away or close() aborted the stream
	}
}

function parseReply(data: string): PickReply | undefined {
	try {
		return replySchema.parse(JSON.parse(data));
	} catch {
		return undefined;
	}
}
