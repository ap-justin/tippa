import type { z } from "zod";
// type-only, so the browser client importing this module never loads zod
import type { pickReplySchema, pickRequestSchema } from "./schema.ts";

/** what the browser client posts to the dev server for one pick; see `pickRequestSchema` */
export type PickRequest = z.output<typeof pickRequestSchema>;

/** payload of the `ui-pick:reply` hmr event */
export type PickReply = z.output<typeof pickReplySchema>;

export type AgentStatus = "connected" | "waiting";

/** payload of the `ui-pick:status` hmr event */
export interface StatusEvent {
	status: AgentStatus;
}

/** what the injected loader passes to the client's `start` */
export interface ClientConfig {
	/** send as `x-ui-pick-token` on every post to `endpoint` */
	token: string;
	/** the dev server path picks are posted to */
	endpoint: string;
	/** pick hotkey; undefined keeps react-grab's default */
	key?: string;
}

export const REPLY_EVENT = "ui-pick:reply";
export const STATUS_EVENT = "ui-pick:status";
/** sent by the loader right after `start` returns; answered with `ui-pick:status` to that client only */
export const STATUS_REQUEST_EVENT = "ui-pick:status-request";
