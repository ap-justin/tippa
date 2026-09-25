import {
	MAX_SCREENSHOT_CHARS,
	type PickElement,
	type PickRequest,
	PNG_BASE64_PREFIX,
} from "../protocol.ts";

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

export interface PickedInput {
	selection: Selection;
	/** png data url */
	screenshot?: string | undefined;
}

export interface PickInput {
	pickId: string;
	note: string;
	/** in marker order: the note refers to `elements[i]` as `[i + 1]` */
	elements: readonly PickedInput[];
}

/** a uuid: hex and dashes, so it fits the helper's `[A-Za-z0-9_-]{1,64}` */
export function newPickId(): string {
	return crypto.randomUUID();
}

export function buildPick({ pickId, note, elements }: PickInput): PickRequest {
	return { pickId, note, elements: elements.map(buildElement) };
}

function buildElement({ selection, screenshot }: PickedInput): PickElement {
	const { component, file, line, column, moduleUrl, html } = selection;
	const base64 = screenshot && base64Of(screenshot);
	const sendable =
		base64?.startsWith(PNG_BASE64_PREFIX) &&
		base64.length <= MAX_SCREENSHOT_CHARS;
	return {
		component,
		file,
		line,
		html,
		...(column !== undefined && { column }),
		...(moduleUrl !== undefined && { moduleUrl }),
		...(sendable && { screenshot: base64 }),
	};
}

/** the helper takes bare base64 and rejects a data url */
export function base64Of(dataUrl: string): string {
	return dataUrl.slice(dataUrl.indexOf(",") + 1);
}
