import type { SourceInfo } from "react-grab/core";
import type { Selection } from "./payload.ts";

export interface ResolvedElement {
	source: SourceInfo | null;
	/** the served module the element's jsx came from; see `moduleUrlOf` */
	moduleUrl?: string | undefined;
	/** react-grab's display name for the element, when its source has none */
	fallbackName?: string | undefined;
	tagName: string;
	html: string;
}

/** undefined when react-grab found no file and line: the helper requires both */
export function toSelection({
	source,
	moduleUrl,
	fallbackName,
	tagName,
	html,
}: ResolvedElement): Selection | undefined {
	if (!source?.filePath || !source.lineNumber) return undefined;
	return {
		component: source.componentName ?? fallbackName ?? tagName,
		file: source.filePath,
		line: source.lineNumber,
		// the sourcemap's column is 0-based; editors and claude count from 1
		...(source.columnNumber !== null && { column: source.columnNumber + 1 }),
		...(moduleUrl !== undefined && { moduleUrl }),
		html,
	};
}
