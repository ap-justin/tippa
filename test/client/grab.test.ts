// @vitest-environment happy-dom
import type {
	ActionContext,
	ContextMenuAction,
	Plugin,
	ReactGrabAPI,
} from "react-grab/core";
import { afterEach, expect, test, vi } from "vitest";
import { startGrab } from "../../src/client/grab.ts";

vi.mock(import("react-grab/core"), async () => ({
	init: vi.fn(),
	formatElementInfo: vi.fn(async () => "<div>$12</div>"),
}));

type ContextMenuActionContext = Parameters<ContextMenuAction["onAction"]>[0];

const STACK = `Error: react-stack-top-frame
    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1a2b3c4d:250:30)
    at PriceCard (http://localhost:5173/src/components/price-card.tsx?t=1:23:7)
    at Object.react_stack_bottom_frame (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1a2b3c4d:18042:20)`;

afterEach(() => {
	delete window.__REACT_GRAB__;
});

function joinGrab() {
	let plugin: Plugin | undefined;
	window.__REACT_GRAB__ = {
		registerPlugin: (registered: Plugin) => {
			plugin = registered;
		},
		setOptions: () => {},
		getSource: async () => ({
			filePath: "price-card.tsx",
			lineNumber: 23,
			columnNumber: 6,
			componentName: "PriceCard",
		}),
		getDisplayName: () => null,
	} as Partial<ReactGrabAPI> as ReactGrabAPI;
	const target = { pick: vi.fn(), grabbing: vi.fn() };
	startGrab(undefined, target);
	const action = plugin?.actions?.[0];
	if (!plugin || !action) throw new Error("no action registered");
	return { plugin, action, target };
}

function context(elements: Element[]): ContextMenuActionContext {
	return {
		element: elements[0],
		elements,
		cleanup: () => {},
	} as Partial<ContextMenuActionContext> as ContextMenuActionContext;
}

test("the action is offered for one element, not a multi-element selection", () => {
	const { action } = joinGrab();
	const enabled = action.enabled as (context: ActionContext) => boolean;
	const [a, b] = [document.createElement("div"), document.createElement("div")];

	expect(enabled(context([a]))).toBe(true);
	expect(enabled(context([a, b]))).toBe(false);
});

test("a pick carries the module its jsx came from", async () => {
	const { action, target } = joinGrab();
	const element = document.createElement("div");
	const error = new Error("react-stack-top-frame");
	error.stack = STACK;
	Object.assign(element, { __reactFiber$abc: { _debugStack: error } });

	await action.onAction(context([element]));

	expect(target.pick).toHaveBeenCalledWith(
		element,
		expect.objectContaining({
			file: "price-card.tsx",
			column: 7,
			moduleUrl: "http://localhost:5173/src/components/price-card.tsx?t=1",
		}),
	);
});

test("the overlay hears when react-grab starts and stops picking", async () => {
	const { plugin, target } = joinGrab();

	await plugin.hooks?.onActivate?.();
	expect(target.grabbing).toHaveBeenLastCalledWith(true);
	await plugin.hooks?.onDeactivate?.();
	expect(target.grabbing).toHaveBeenLastCalledWith(false);
});

test("a click that copies one element opens the note on it once react-grab has let go of focus", async () => {
	const { plugin, target } = joinGrab();
	const element = document.createElement("div");

	await plugin.hooks?.onActivate?.();
	await plugin.hooks?.onCopySuccess?.([element], "<div>$12</div>");
	await new Promise((resolve) => setTimeout(resolve));
	// react-grab restores its own focus inside deactivate; the note's focus has to come after
	expect(target.pick).not.toHaveBeenCalled();

	await plugin.hooks?.onDeactivate?.();

	await vi.waitFor(() =>
		expect(target.pick).toHaveBeenCalledWith(
			element,
			expect.objectContaining({ file: "price-card.tsx", line: 23 }),
		),
	);
});

test("a drag that copies several elements doesn't open the note", async () => {
	const { plugin, target } = joinGrab();
	const [a, b] = [document.createElement("div"), document.createElement("div")];

	await plugin.hooks?.onActivate?.();
	await plugin.hooks?.onCopySuccess?.([a, b], "<div></div><div></div>");
	await plugin.hooks?.onDeactivate?.();

	expect(target.pick).not.toHaveBeenCalled();
});

test("react-grab's copy goes ahead: nothing intercepts the select or rewrites the clipboard", async () => {
	const { plugin } = joinGrab();

	expect(plugin.hooks?.onElementSelect).toBeUndefined();
	expect(plugin.hooks?.transformCopyContent).toBeUndefined();
	expect(
		await plugin.hooks?.onCopySuccess?.([document.createElement("div")], "x"),
	).toBeUndefined();
});
