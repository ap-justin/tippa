/** what the browser client posts to the dev server for one pick */
export interface PickRequest {
	/** 1-64 chars of `[A-Za-z0-9_-]` */
	pickId: string;
	note: string;
	component: string;
	file: string;
	line: number;
	column?: number | undefined;
	/** the dev server keeps the first 4000 chars */
	html: string;
	/** base64 png of the picked element */
	screenshot?: string | undefined;
}

/** payload of the `ui-pick:reply` hmr event */
export interface PickReply {
	pickId: string;
	status: "working" | "done" | "question";
	message: string;
}

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
