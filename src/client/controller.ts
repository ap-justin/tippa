import type { ViteHotContext } from "vite/types/hot.d.ts";
import {
	type AgentStatus,
	type ClientConfig,
	type PickRequest,
	STATUS_EVENT,
	type StatusEvent,
} from "../protocol.ts";

export const NOT_CONNECTED = "Claude isn't connected";

export type SendOutcome = { ok: true } | { ok: false; error: string };

/** claude's connection and the post of each pick, with no dom: the overlay renders from it */
export class PickController {
	readonly #config: ClientConfig;
	readonly #post: typeof fetch;
	readonly #listeners = new Set<() => void>();
	// unknown until the dev server answers the loader's status request; a send then learns it from a 503
	#status: AgentStatus | undefined;
	// bumped per status event, so a send can tell its 503 is older than the latest status
	#statusVersion = 0;

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
		this.#statusVersion++;
		this.#changed();
	}

	#changed(): void {
		for (const listener of this.#listeners) listener();
	}

	async send(pick: PickRequest): Promise<SendOutcome> {
		const statusVersion = this.#statusVersion;
		const outcome = await this.#post(this.#config.endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-tippa-token": this.#config.token,
			},
			body: JSON.stringify(pick),
		}).then(toOutcome, unreachable);
		if (
			!outcome.ok &&
			outcome.error === NOT_CONNECTED &&
			statusVersion === this.#statusVersion &&
			this.#status !== "waiting"
		) {
			this.#status = "waiting";
			this.#changed();
		}
		return outcome;
	}
}

declare module "vite/types/customEvent.d.ts" {
	interface CustomEventMap {
		[STATUS_EVENT]: StatusEvent;
	}
}

export function listen(
	hot: Pick<ViteHotContext, "on">,
	controller: PickController,
): void {
	hot.on(STATUS_EVENT, (status: StatusEvent) =>
		controller.handleStatus(status),
	);
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
