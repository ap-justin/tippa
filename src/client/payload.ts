import type { PickRequest } from "../protocol.ts";

// the dev server refuses bodies over 10 MiB; leave room for the html and the json around it
const MAX_SCREENSHOT_CHARS = 8_000_000;

/** where react-grab resolved the picked element to */
export interface Selection {
	component: string;
	file: string;
	line: number;
	column?: number | undefined;
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
	const { component, file, line, column, html } = selection;
	// the helper takes bare base64 and rejects a data url
	const base64 = screenshot?.slice(screenshot.indexOf(",") + 1);
	return {
		pickId,
		note,
		component,
		file,
		line,
		html,
		...(column !== undefined && { column }),
		...(base64 !== undefined &&
			base64.length <= MAX_SCREENSHOT_CHARS && { screenshot: base64 }),
	};
}
