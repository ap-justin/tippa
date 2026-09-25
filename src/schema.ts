import { z } from "zod";

/** the dev server keeps this many leading chars of a pick's html */
export const MAX_HTML_CHARS = 4000;

/** what the browser client posts to the dev server for one pick */
export const pickRequestSchema = z.object({
	// becomes a filename, so no path separators or dots
	pickId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
	note: z.string(),
	component: z.string(),
	/** as the client posts it, a vite url; as an agent receives it, an absolute path */
	file: z.string(),
	line: z.number().int().positive(),
	column: z.number().int().positive().optional(),
	/** the dev server keeps the first {@link MAX_HTML_CHARS} */
	html: z.string(),
	/** base64 png of the picked element */
	screenshot: z.base64().optional(),
});

/** what an agent reports back about a pick, sent to the page as the `ui-pick:reply` hmr event */
export const pickReplySchema = z.object({
	pickId: z.string(),
	status: z.enum(["working", "done", "question"]),
	message: z.string(),
});
