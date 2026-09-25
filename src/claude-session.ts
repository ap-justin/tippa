import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { AgentAdapter, AgentConnection } from "./agent.ts";
import { type Discovery, discoveryPath } from "./channel/discovery.ts";
import type { AgentStatus, PickReply, PickRequest } from "./protocol.ts";

const POLL_MS = 2000;

const discoverySchema = z.object({
	port: z.number().int().positive(),
	secret: z.string().min(1),
	pid: z.number().int(),
});

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
	return { label: "Claude", connect: ({ root }) => connectToHelper(root) };
}

function connectToHelper(root: string): AgentConnection {
	const statusListeners = new Set<(status: AgentStatus) => void>();
	const replyListeners = new Set<(reply: PickReply) => void>();
	let status: AgentStatus = "waiting";
	let announced = false;
	let helper: Discovery | undefined;
	let events: AbortController | undefined;
	let timer: NodeJS.Timeout | undefined;
	let closed = false;

	function setStatus(next: AgentStatus): void {
		if (announced && next === status) return;
		announced = true;
		status = next;
		for (const listener of statusListeners) listener(next);
	}

	async function check(): Promise<void> {
		const found = await findDiscovery(root);
		const listening = found !== undefined && !closed && (await listen(found));
		if (closed || listening) return;
		setStatus("waiting");
		timer = setTimeout(check, POLL_MS).unref();
	}

	/** resolves true once the reply stream is open; a later drop restarts polling */
	async function listen(found: Discovery): Promise<boolean> {
		const controller = new AbortController();
		let stream: ReadableStream<Uint8Array>;
		try {
			const health = await fetch(helperUrl(found, "/health"), {
				headers: auth(found),
				signal: AbortSignal.timeout(POLL_MS),
			});
			if (!health.ok) return false;
			const res = await fetch(helperUrl(found, "/events"), {
				headers: auth(found),
				signal: controller.signal,
			});
			if (!res.ok || !res.body) return false;
			stream = res.body;
		} catch {
			return false;
		}
		if (closed) {
			controller.abort();
			return false;
		}
		helper = found;
		events = controller;
		setStatus("connected");
		void readReplies(stream, emitReply).then(() => {
			helper = undefined;
			events = undefined;
			if (!closed) void check();
		});
		return true;
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
			if (!target) throw new Error("Claude isn't connected");
			const res = await fetch(helperUrl(target, "/pick"), {
				method: "POST",
				headers: { ...auth(target), "content-type": "application/json" },
				body: JSON.stringify(pick),
			});
			if (res.status !== 202) {
				throw new Error(
					`helper refused the pick (${res.status}): ${await res.text()}`,
				);
			}
		},
		async close() {
			closed = true;
			clearTimeout(timer);
			events?.abort();
		},
	};
}

/** the nearest discovery file wins; an unreadable one reads as no helper */
async function findDiscovery(root: string): Promise<Discovery | undefined> {
	for (let dir = root; ; dir = dirname(dir)) {
		let text: string;
		try {
			text = await readFile(discoveryPath(dir), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
			if (dirname(dir) === dir) return undefined;
			continue;
		}
		try {
			return discoverySchema.parse(JSON.parse(text));
		} catch {
			return undefined;
		}
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
