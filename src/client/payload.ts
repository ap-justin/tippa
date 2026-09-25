import { MAX_SCREENSHOT_CHARS, type PickRequest } from "../protocol.ts";

// base64 of the png signature; schema.ts checks the same prefix, but importing it would bundle zod
const PNG_BASE64_PREFIX = "iVBORw0KGgo";

/** where react-grab resolved the picked element to */
export interface Selection {
	component: string;
	file: string;
	line: number;
	column?: number | undefined;
	/** see `pickRequestSchema`'s `moduleUrl` */
	moduleUrl?: string | undefined;
	html: string;
}

export interface PickInput {
	pickId: string;
	note: string;
	selection: Selection;
	/** png data url */
	screenshot?: string | undefined;
}

/** a uuid: hex and dashes, so it fits the helper's `[A-Za-z0-9_-]{1,64}` */
export function newPickId(): string {
	return crypto.randomUUID();
}

export function buildPick({
	pickId,
	note,
	selection,
	screenshot,
}: PickInput): PickRequest {
	const { component, file, line, column, moduleUrl, html } = selection;
	// the helper takes bare base64 and rejects a data url
	const base64 = screenshot?.slice(screenshot.indexOf(",") + 1);
	const sendable =
		base64?.startsWith(PNG_BASE64_PREFIX) &&
		base64.length <= MAX_SCREENSHOT_CHARS;
	return {
		pickId,
		note,
		component,
		file,
		line,
		html,
		...(column !== undefined && { column }),
		...(moduleUrl !== undefined && { moduleUrl }),
		...(sendable && { screenshot: base64 }),
	};
}
