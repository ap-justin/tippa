import type { z } from "zod";
// type-only, so the browser client importing this module never loads zod
import type { pickReplySchema, pickRequestSchema } from "./schema.ts";

/** see `pickRequestSchema` */
export type PickRequest = z.output<typeof pickRequestSchema>;

/** payload of the `tippa:reply` hmr event */
export type PickReply = z.output<typeof pickReplySchema>;

export type AgentStatus = "connected" | "waiting";

/** payload of the `tippa:status` hmr event */
export interface StatusEvent {
	status: AgentStatus;
}

/** what the injected loader passes to the client's `start` */
export interface ClientConfig {
	/** send as `x-tippa-token` on every post to `endpoint` */
	token: string;
	/** the dev server path picks are posted to */
	endpoint: string;
	/** pick hotkey; undefined keeps react-grab's default */
	key?: string;
}

/** the dev server and the channel helper refuse a pick body past this */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;
/** base64 chars a screenshot may take, leaving room in the body for the html and the json around it */
export const MAX_SCREENSHOT_CHARS = MAX_BODY_BYTES - 2 * 1024 * 1024;
/** base64 of the 8-byte png signature and the ihdr length's leading zero bits */
export const PNG_BASE64_PREFIX = "iVBORw0KGgo";

export const REPLY_EVENT = "tippa:reply";
export const STATUS_EVENT = "tippa:status";
/** sent by the loader right after `start` returns; answered with `tippa:status` to that client only */
export const STATUS_REQUEST_EVENT = "tippa:status-request";
