import type { Logger } from "vite";
import type { AgentStatus, PickReply, PickRequest } from "./protocol.ts";

/** how ui-pick reaches a coding agent; `claudeSession()` is one */
export interface AgentAdapter {
	/** shown in the status line: `ui-pick → connected to <label>` */
	label: string;
	connect(context: AgentContext): AgentConnection;
}

export interface AgentContext {
	/** vite's resolved root */
	root: string;
	logger: Logger;
}

export interface AgentConnection {
	readonly status: AgentStatus;
	/** called after the first connection check, then once per change */
	onStatus(listener: (status: AgentStatus) => void): void;
	onReply(listener: (reply: PickReply) => void): void;
	/** rejects when the agent refuses or can't be reached */
	send(pick: PickRequest): Promise<void>;
	close(): Promise<void>;
}
