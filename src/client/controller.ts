import type { ViteHotContext } from "vite/types/hot.d.ts";
import {
	type AgentStatus,
	type ClientConfig,
	type PickReply,
	type PickRequest,
	REPLY_EVENT,
	STATUS_EVENT,
	type StatusEvent,
} from "../protocol.ts";

export type Badge = "sending" | "sent" | "working" | "done" | "question";

export interface PickState {
	badge: Badge;
	/** claude's reply, shown in the bubble */
	message?: string;
}

export const NOT_CONNECTED = "Claude isn't connected";

export type SendOutcome = { ok: true } | { ok: false; error: string };

/** send state and replies per pick, with no dom: the overlay renders from it */
export class PickController {
	readonly picks = new Map<string, PickState>();
	readonly #config: ClientConfig;
	readonly #post: typeof fetch;
	readonly #listeners = new Set<() => void>();
	// unknown until the dev server answers the loader's status request; a send then learns it from a 503
	#status: AgentStatus | undefined;

	constructor(config: ClientConfig, post: typeof fetch) {
		this.#config = config;
		this.#post = post;
	}

	get canSend(): boolean {
		return this.#status !== "waiting";
	}

	get notice(): string | undefined {
		return this.canSend ? undefined : NOT_CONNECTED;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	handleStatus({ status }: StatusEvent): void {
		this.#status = status;
		this.#changed();
	}

	handleReply({ pickId, status, message }: PickReply): void {
		if (!this.picks.has(pickId)) return;
		this.picks.set(pickId, { badge: status, ...(message && { message }) });
		this.#changed();
	}

	#changed(): void {
		for (const listener of this.#listeners) listener();
	}

	async send(pick: PickRequest): Promise<SendOutcome> {
		this.picks.set(pick.pickId, { badge: "sending" });
		this.#changed();
		const outcome = await this.#post(this.#config.endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-ui-pick-token": this.#config.token,
			},
			body: JSON.stringify(pick),
		}).then(toOutcome, unreachable);
		if (!outcome.ok) {
			this.picks.delete(pick.pickId);
			if (outcome.error === NOT_CONNECTED) this.#status = "waiting";
		}
		// a reply can beat the 202 here; it outranks "sent"
		else if (this.picks.get(pick.pickId)?.badge === "sending")
			this.picks.set(pick.pickId, { badge: "sent" });
		this.#changed();
		return outcome;
	}
}

declare module "vite/types/customEvent.d.ts" {
	interface CustomEventMap {
		[STATUS_EVENT]: StatusEvent;
		[REPLY_EVENT]: PickReply;
	}
}

export function listen(
	hot: Pick<ViteHotContext, "on">,
	controller: PickController,
): void {
	hot.on(STATUS_EVENT, (status: StatusEvent) =>
		controller.handleStatus(status),
	);
	hot.on(REPLY_EVENT, (reply: PickReply) => controller.handleReply(reply));
}

async function toOutcome(response: Response): Promise<SendOutcome> {
	if (response.status === 202) return { ok: true };
	if (response.status === 503) return { ok: false, error: NOT_CONNECTED };
	const body: unknown = await response.json().catch(() => undefined);
	const { error, message } = isRecord(body) ? body : {};
	const reason =
		typeof error === "string"
			? `${response.status} ${error}`
			: `${response.status}`;
	const detail = typeof message === "string" ? `: ${message}` : "";
	return { ok: false, error: `Couldn't send (${reason})${detail}` };
}

function unreachable(error: unknown): SendOutcome {
	const reason = error instanceof Error ? error.message : String(error);
	return { ok: false, error: `Couldn't reach the dev server: ${reason}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
