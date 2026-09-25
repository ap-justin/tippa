import { parseStack } from "bippy/source";

// react 19 names the frame that calls a component this; react-grab trusts a stack only when it's there
const BOTTOM_FRAMES = ["react_stack_bottom_frame", "react-stack-bottom-frame"];

interface DebugFiber {
	_debugStack?: unknown;
	_debugOwner?: DebugFiber | null;
}

/**
 * the served module the picked element's jsx was written in, as the browser loaded it. mirrors
 * how react-grab 0.2.0 picks the frame it reads `file` from: the element's own `_debugStack`
 * frame, or, when that's inside a package (a <Link>'s <a>), the first frame outside
 * `node_modules` up the `_debugOwner` chain. undefined without a react dev build's stacks.
 */
export function moduleUrlOf(element: Element): string | undefined {
	for (
		let fiber = fiberOf(element);
		fiber;
		fiber = fiber._debugOwner ?? undefined
	) {
		const stack = fiber._debugStack;
		if (!(stack instanceof Error) || typeof stack.stack !== "string") continue;
		const url = frameUrls(stack.stack).find((frame) => !isPackage(frame));
		if (url) return url;
	}
	return undefined;
}

/**
 * the frame react-grab symbolicates: the first frame with a file below jsx's own (the first
 * frame), above react's bottom frame. query, hash and percent-encoding kept as the browser
 * wrote them; only `:line:col` is stripped.
 */
export function moduleUrlFromStack(stack: string): string | undefined {
	return frameUrls(stack)[0];
}

/** the stack's frame urls between jsx's frame and react's bottom one; none when it has no bottom */
function frameUrls(stack: string): string[] {
	const bottom = BOTTOM_FRAMES.map((name) => stack.indexOf(name)).find(
		(index) => index !== -1,
	);
	if (bottom === undefined) return [];
	return parseStack(stack.slice(0, stack.lastIndexOf("\n", bottom)))
		.slice(1)
		.flatMap((frame) => (frame.fileName ? [frame.fileName] : []));
}

function isPackage(url: string): boolean {
	return new URL(url, location.href).pathname.includes("/node_modules/");
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
