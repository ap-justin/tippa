import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "vite";
import { z } from "zod";
import {
	type AgentAdapter,
	type AgentConnection,
	AgentNotConnectedError,
} from "./agent.ts";
import {
	type Discovery,
	discoveryPath,
	discoverySchema,
	isAlive,
} from "./channel/discovery.ts";
import type { AgentStatus, PickRequest } from "./protocol.ts";

const LABEL = "Claude";
const POLL_MS = 2000;
const SEND_TIMEOUT_MS = 10_000;

const healthSchema = z.object({ ok: z.literal(true) });

/**
 * sends picks to the claude code session running the `tippa-channel` helper.
 * finds the helper through the nearest `.tippa/channel.json` at or above vite's root.
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
			if (result.reason) logger.warnOnce(`tippa: ${result.reason}`);
			return wait();
		}
		helper = result.discovery;
		setStatus("connected");
		void drain(result.stream).then(() => {
			if (!closed) wait();
		});
	}

	void check();

	return {
		get status() {
			return status;
		},
		onStatus(listener) {
			statusListeners.add(listener);
		},
		async send(pick: PickRequest) {
			const target = helper;
			if (!target) throw new AgentNotConnectedError(LABEL);
			const res = await fetch(helperUrl(target, "/pick"), {
				method: "POST",
				headers: { ...auth(target), "content-type": "application/json" },
				body: JSON.stringify(pick),
				signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
			}).catch((error: unknown) => {
				// the helper exited, and its stream's end hasn't been read yet
				if (isHelperGone(error)) throw new AgentNotConnectedError(LABEL);
				throw error;
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
 * checks the port answers as the helper, then opens its events stream, which stays open while the helper runs.
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

function isHelperGone(error: unknown): boolean {
	const code = (error as { cause?: { code?: unknown } } | undefined)?.cause
		?.code;
	return code === "ECONNREFUSED" || code === "ECONNRESET";
}

function isHealthy(body: string): boolean {
	try {
		return healthSchema.safeParse(JSON.parse(body)).success;
	} catch {
		return false;
	}
}

function helperUrl({ port }: Discovery, path: string): string {
	return `http://127.0.0.1:${port}${path}`;
}

function auth({ secret }: Discovery): Record<string, string> {
	return { "x-tippa-secret": secret };
}

/** resolves when the helper ends the stream, or close() aborts it */
async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
	try {
		for await (const _ of stream);
	} catch {
		// the helper went away or close() aborted the stream
	}
}
