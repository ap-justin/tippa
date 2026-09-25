import { isAbsolute, relative, sep } from "node:path";
import type { PickElement, PickRequest } from "../protocol.ts";

/** `file` relative to `projectDir` when inside it, so claude's working dir resolves it; unchanged otherwise */
export function projectRelative(projectDir: string, file: string): string {
	const inside = relative(projectDir, file);
	const outside =
		inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
	return outside ? file : inside;
}

/** the note, then one block per element headed by the marker the note refers to it by */
export function formatContent(
	pick: PickRequest,
	screenshotPaths: readonly (string | undefined)[],
): string {
	const blocks = pick.elements.map((element, index) =>
		formatElement(element, index + 1, screenshotPaths[index]),
	);
	return [pick.note, ...blocks]
		.join("\n\n")
		.replace(/<\/(channel)/gi, "<\\/$1");
}

function formatElement(
	element: PickElement,
	marker: number,
	screenshotPath: string | undefined,
): string {
	const location = [element.file, element.line, element.column]
		.filter((part) => part !== undefined)
		.join(":");
	return [
		`[${marker}] component: ${oneLine(element.component)}`,
		`source: ${oneLine(location)}`,
		...(screenshotPath ? [`screenshot: ${screenshotPath}`] : []),
		"html:",
		fenced(element.html, "html"),
	].join("\n");
}

/** page data on a header line can't start a line of its own and forge another element's block */
function oneLine(text: string): string {
	return text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, "");
}

/** a fence one backtick longer than any run inside, so the text can't end it */
function fenced(text: string, lang: string): string {
	const longest = Math.max(
		0,
		...Array.from(text.matchAll(/`+/g), (run) => run[0].length),
	);
	const fence = "`".repeat(Math.max(4, longest + 1));
	return `${fence}${lang}\n${text}\n${fence}`;
}

/** meta values become `<channel>` tag attributes, so they hold no page data */
export function formatMeta(pick: PickRequest): Record<string, string> {
	return {
		pick_id: pick.pickId,
		elements: String(pick.elements.length),
	};
}
