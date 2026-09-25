import { expect, test } from "vitest";
import { toSelection } from "../../src/client/selection.ts";

const html = "<button>Save</button>";

const moduleUrl = "http://localhost:5173/src/ui/save-button.tsx?t=1";

test("maps react-grab's source info and the module it came from to a selection", () => {
	expect(
		toSelection({
			source: {
				filePath: "save-button.tsx",
				lineNumber: 12,
				columnNumber: 5,
				componentName: "SaveButton",
			},
			moduleUrl,
			tagName: "button",
			html,
		}),
	).toStrictEqual({
		component: "SaveButton",
		file: "save-button.tsx",
		line: 12,
		column: 6,
		moduleUrl,
		html,
	});
});

test("the sourcemap's 0-based column becomes the editor's 1-based one", () => {
	const selection = toSelection({
		source: {
			filePath: "save-button.tsx",
			lineNumber: 12,
			columnNumber: 0,
			componentName: "SaveButton",
		},
		tagName: "button",
		html,
	});
	expect(selection?.column).toBe(1);
});

test("no module url leaves the field out", () => {
	const selection = toSelection({
		source: {
			filePath: "/src/app.tsx",
			lineNumber: 12,
			columnNumber: 5,
			componentName: "SaveButton",
		},
		tagName: "button",
		html,
	});
	expect(selection && "moduleUrl" in selection).toBe(false);
});

test("an unknown column is left out", () => {
	const selection = toSelection({
		source: {
			filePath: "/src/app.tsx",
			lineNumber: 12,
			columnNumber: null,
			componentName: "SaveButton",
		},
		tagName: "button",
		html,
	});
	expect(selection && "column" in selection).toBe(false);
});

test("with no component name the fallback name, then the tag, stands in", () => {
	const source = {
		filePath: "/src/app.tsx",
		lineNumber: 12,
		columnNumber: null,
		componentName: null,
	};
	expect(
		toSelection({ source, fallbackName: "Toolbar", tagName: "button", html })
			?.component,
	).toBe("Toolbar");
	expect(toSelection({ source, tagName: "button", html })?.component).toBe(
		"button",
	);
});

test("no source file or line means nothing sendable", () => {
	expect(toSelection({ source: null, tagName: "div", html })).toBeUndefined();
	expect(
		toSelection({
			source: {
				filePath: "/src/app.tsx",
				lineNumber: null,
				columnNumber: null,
				componentName: "X",
			},
			tagName: "div",
			html,
		}),
	).toBeUndefined();
});

test.each([
	["the module's own path", "/src/ui/save-button.tsx"],
	["the path with react-grab's short /src dropped", "/ui/save-button.tsx"],
])(
	"when react-grab couldn't apply the sourcemap (file is %s), the column stays and no module url goes",
	(_, filePath) => {
		const selection = toSelection({
			source: {
				filePath,
				lineNumber: 40,
				columnNumber: 5,
				componentName: "SaveButton",
			},
			moduleUrl,
			tagName: "button",
			html,
		});
		expect(selection?.column).toBe(5);
		expect(selection && "moduleUrl" in selection).toBe(false);
	},
);
