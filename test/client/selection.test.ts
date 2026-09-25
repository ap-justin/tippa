import { expect, test } from "vitest";
import { toSelection } from "../../src/client/selection.ts";

const html = "<button>Save</button>";

test("maps react-grab's source info to a selection", () => {
	expect(
		toSelection({
			source: {
				filePath: "/src/app.tsx",
				lineNumber: 12,
				columnNumber: 5,
				componentName: "SaveButton",
			},
			tagName: "button",
			html,
		}),
	).toEqual({
		component: "SaveButton",
		file: "/src/app.tsx",
		line: 12,
		column: 5,
		html,
	});
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
