import { z } from "zod";
import { MAX_SCREENSHOT_CHARS, PNG_BASE64_PREFIX } from "./protocol.ts";

/** the dev server keeps this many leading chars of a pick's html */
export const MAX_HTML_CHARS = 4000;

const MAX_MODULE_URL_CHARS = 2048;

// a `<channel>` tag attribute and the key claude's replies are routed by
export const pickIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** base64 png; checked by prefix, so it holds in the browser as well as node */
export const pngBase64Schema = z
	.base64()
	.max(MAX_SCREENSHOT_CHARS)
	.refine((value) => value.startsWith(PNG_BASE64_PREFIX), "not a png");

/** what the browser client posts to the dev server for one pick */
export const pickRequestSchema = z.object({
	pickId: pickIdSchema,
	note: z.string(),
	component: z.string(),
	/**
	 * as the client posts it, react-grab's source: the sourcemap's `sources` entry, relative to
	 * {@link moduleUrl}'s directory; as an agent receives it, an absolute path
	 */
	file: z.string(),
	line: z.number().int().positive(),
	column: z.number().int().positive().optional(),
	/**
	 * the served module the component came from, as the browser loaded it: an absolute
	 * same-origin url or a root-relative path, e.g. `http://localhost:5173/src/ui/Button.tsx?t=1`
	 * or `/@fs/abs/Button.tsx`; without it, `file` is read as a vite url
	 */
	moduleUrl: z.string().max(MAX_MODULE_URL_CHARS).optional(),
	/** the dev server keeps the first {@link MAX_HTML_CHARS} */
	html: z.string(),
	/** base64 png of the picked element */
	screenshot: pngBase64Schema.optional(),
});

/** what an agent reports back about a pick, sent to the page as the `ui-pick:reply` hmr event */
export const pickReplySchema = z.object({
	pickId: z.string(),
	status: z.enum(["working", "done", "question"]),
	message: z.string(),
});
