// @vitest-environment happy-dom
import { expect, test } from "vitest";
import {
	moduleUrlFromStack,
	moduleUrlOf,
} from "../../src/client/module-url.ts";

// react 19's `_debugStack` for a <div> rendered by PriceCard, as each engine formats it
const CHROME = `Error: react-stack-top-frame
    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1a2b3c4d:250:30)
    at PriceCard (http://localhost:5173/src/components/price%20card.tsx?t=1712345678901:23:7)
    at Object.react_stack_bottom_frame (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1a2b3c4d:18042:20)
    at renderWithHooks (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1a2b3c4d:5654:24)`;

const FIREFOX = `exports.jsxDEV@http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1a2b3c4d:250:30
PriceCard@http://localhost:5173/@fs/Users/me/shared/price-card.tsx:23:7
react_stack_bottom_frame@http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1a2b3c4d:18042:20
renderWithHooks@http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1a2b3c4d:5654:24
`;

test("the first frame below jsxDEV names the module, with only :line:col stripped", () => {
	expect(moduleUrlFromStack(CHROME)).toBe(
		"http://localhost:5173/src/components/price%20card.tsx?t=1712345678901",
	);
});

test("firefox and safari's fn@url frames, an @ in the path included", () => {
	expect(moduleUrlFromStack(FIREFOX)).toBe(
		"http://localhost:5173/@fs/Users/me/shared/price-card.tsx",
	);
});

test("an anonymous component's frame has no function name", () => {
	const stack = CHROME.replace(
		"at PriceCard (http://localhost:5173/src/components/price%20card.tsx?t=1712345678901:23:7)",
		"at http://localhost:5173/src/app.tsx:3:9",
	);
	expect(moduleUrlFromStack(stack)).toBe("http://localhost:5173/src/app.tsx");
});

test("a stack cut off before react's bottom frame isn't trusted, as react-grab doesn't", () => {
	const cut = CHROME.split("\n").slice(0, 3).join("\n");
	expect(moduleUrlFromStack(cut)).toBeUndefined();
});

test("react's shared stack for elements past its owner-stack budget names no module", () => {
	const unknownOwner = `Error: react-stack-top-frame
    at UnknownOwner (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1a2b3c4d:120:14)
    at Object.react_stack_bottom_frame (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1a2b3c4d:316:16)`;
	expect(moduleUrlFromStack(unknownOwner)).toBeUndefined();
});

function withStack(stack: string): Error {
	const error = new Error("react-stack-top-frame");
	error.stack = stack;
	return error;
}

test("reads the stack off the fiber react-dom keeps on the nearest rendered ancestor", () => {
	const rendered = document.createElement("div");
	Object.assign(rendered, {
		__reactFiber$x1y2z3: { _debugStack: withStack(CHROME) },
	});
	const inner = rendered.appendChild(document.createElement("span"));

	expect(moduleUrlOf(inner)).toBe(
		"http://localhost:5173/src/components/price%20card.tsx?t=1712345678901",
	);
});

test("no fiber, as outside react or in a production build, names no module", () => {
	expect(moduleUrlOf(document.createElement("div"))).toBeUndefined();
	const rendered = document.createElement("div");
	Object.assign(rendered, { __reactFiber$x1y2z3: {} });
	expect(moduleUrlOf(rendered)).toBeUndefined();
});

test.each([
	[
		"chrome",
		`Error: react-stack-top-frame
    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1a2b3c4d:250:30)
    at Login (http://localhost:5173/src/routes/(auth)/($lang).login.tsx?t=1:9:3)
    at Object.react_stack_bottom_frame (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1a2b3c4d:18042:20)`,
	],
	[
		"firefox",
		`exports.jsxDEV@http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1a2b3c4d:250:30
Login@http://localhost:5173/src/routes/(auth)/($lang).login.tsx?t=1:9:3
react_stack_bottom_frame@http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1a2b3c4d:18042:20
`,
	],
])("parenthesized route directories stay in the url (%s)", (_, stack) => {
	expect(moduleUrlFromStack(stack)).toBe(
		"http://localhost:5173/src/routes/(auth)/($lang).login.tsx?t=1",
	);
});

test("a node a library created names the app module that rendered the library's component", () => {
	// TanStack's <Link> creates the <a> inside the deps bundle; Nav rendered the <Link>
	const link = {
		_debugStack: withStack(`Error: react-stack-top-frame
    at exports.jsx (http://localhost:5173/node_modules/.vite/deps/react_jsx-runtime.js?v=1a2b3c4d:20:13)
    at Link (http://localhost:5173/node_modules/.vite/deps/@tanstack_react-router.js?v=1a2b3c4d:2991:12)
    at Object.react_stack_bottom_frame (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1a2b3c4d:18042:20)`),
		_debugOwner: {
			tag: 0,
			_debugStack: withStack(`Error: react-stack-top-frame
    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1a2b3c4d:250:30)
    at Nav (http://localhost:5173/src/nav.tsx?t=1:14:9)
    at Object.react_stack_bottom_frame (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1a2b3c4d:18042:20)`),
			_debugOwner: null,
		},
	};
	const anchor = document.createElement("a");
	Object.assign(anchor, { __reactFiber$x1y2z3: { tag: 5, ...link } });

	expect(moduleUrlOf(anchor)).toBe("http://localhost:5173/src/nav.tsx?t=1");
});
