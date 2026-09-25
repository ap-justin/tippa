import { isAbsolute, relative, sep } from "node:path";
import type { z } from "zod";
import { pickRequestSchema, pngBase64Schema } from "../schema.ts";

export const pickSchema = pickRequestSchema.extend({
	screenshot: pngBase64Schema
		.transform((value) => Buffer.from(value, "base64"))
		.optional(),
});

export type Pick = z.output<typeof pickSchema>;

/** `file` relative to `projectDir` when inside it, so claude's working dir resolves it; unchanged otherwise */
export function projectRelative(projectDir: string, file: string): string {
	const inside = relative(projectDir, file);
	const outside =
		inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
	return outside ? file : inside;
}

export function formatContent(pick: Pick): string {
	const location = [pick.file, pick.line, pick.column]
		.filter((part) => part !== undefined)
		.join(":");
	return [
		pick.note,
		"",
		`component: ${pick.component}`,
		`source: ${location}`,
		"html:",
		fenced(pick.html, "html"),
	]
		.join("\n")
		.replace(/<\/(channel)/gi, "<\\/$1");
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

export function formatMeta(
	pick: Pick,
	screenshotPath: string | undefined,
): Record<string, string> {
	return {
		pick_id: pick.pickId,
		component: pick.component,
		file: pick.file,
		line: String(pick.line),
		...(screenshotPath && { screenshot: screenshotPath }),
	};
}
