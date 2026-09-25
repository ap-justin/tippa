import { z } from "zod";

const PNG_SIGNATURE = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export const pickSchema = z.object({
	// becomes a filename, so no path separators or dots
	pickId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
	note: z.string(),
	component: z.string(),
	file: z.string(),
	line: z.number().int().positive(),
	column: z.number().int().positive().optional(),
	html: z.string(),
	screenshot: z
		.base64()
		.transform((value) => Buffer.from(value, "base64"))
		.refine((png) => png.subarray(0, 8).equals(PNG_SIGNATURE), "not a png")
		.optional(),
});

export type Pick = z.output<typeof pickSchema>;

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
