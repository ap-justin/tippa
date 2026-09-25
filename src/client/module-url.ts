// react 19 names the frame that calls a component this; react-grab trusts a stack only when it's there
const BOTTOM_FRAME = /react[_-]stack[_-]bottom[_-]frame/;
// a frame's url: chrome's `at fn (url:line:col)` / `at url:line:col`, firefox and safari's `fn@url:line:col`
const FRAME_URL = /(https?:\/\/[^\s()]+?):\d+:\d+\)?\s*$/;

interface DebugFiber {
	_debugStack?: unknown;
}

/**
 * the served module the picked element's jsx was written in, as the browser loaded it: the url
 * react-grab resolved the element's source map from. undefined without a react dev build's
 * `_debugStack` on the element's fiber.
 */
export function moduleUrlOf(element: Element): string | undefined {
	const stack = fiberOf(element)?._debugStack;
	return stack instanceof Error && typeof stack.stack === "string"
		? moduleUrlFromStack(stack.stack)
		: undefined;
}

/**
 * the frame react-grab symbolicates: the first frame with a url below jsxDEV's (the first frame),
 * above react's bottom frame. query, hash and percent-encoding kept as the browser wrote them.
 */
export function moduleUrlFromStack(stack: string): string | undefined {
	const lines = stack.split("\n");
	const bottom = lines.findIndex((line) => BOTTOM_FRAME.test(line));
	if (bottom === -1) return undefined;
	const urls = lines
		.slice(0, bottom)
		.map((line) => FRAME_URL.exec(line)?.[1])
		.filter((url) => url !== undefined);
	return urls[1];
}

// react-dom keys each host node's fiber as `__reactFiber$<random>`; react-grab walks up the same way
function fiberOf(element: Element): DebugFiber | undefined {
	let node: Element | null = element;
	while (node) {
		const key = Object.keys(node).find((name) =>
			name.startsWith("__reactFiber$"),
		);
		if (key) return (node as unknown as Record<string, DebugFiber>)[key];
		node = node.parentElement ?? hostOf(node);
	}
	return undefined;
}

function hostOf(node: Element): Element | null {
	const root = node.getRootNode();
	return root instanceof ShadowRoot ? root.host : null;
}
