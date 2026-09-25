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
	const unmapped =
		moduleUrl !== undefined && isModulePath(source.filePath, moduleUrl);
	return {
		component: source.componentName ?? fallbackName ?? tagName,
		file: source.filePath,
		line: source.lineNumber,
		// a sourcemap's column is 0-based; an unmapped frame's is already 1-based, like editors'
		...(source.columnNumber !== null && {
			column: source.columnNumber + (unmapped ? 0 : 1),
		}),
		...(moduleUrl !== undefined && !unmapped && { moduleUrl }),
		html,
	};
}

/**
 * react-grab hands back the module's own url path when it couldn't apply the sourcemap, minus
 * a short `/src` it drops; a mapped source is relative to the module's directory
 */
function isModulePath(filePath: string, moduleUrl: string): boolean {
	return (
		filePath.startsWith("/") &&
		// only the path is read, so any base resolves a root-relative url
		new URL(moduleUrl, "http://localhost").pathname.endsWith(filePath)
	);
}
