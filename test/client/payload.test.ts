import { expect, test } from "vitest";
import { buildPick, newPickId } from "../../src/client/payload.ts";
import { toSelection } from "../../src/client/selection.ts";
import { MAX_SCREENSHOT_CHARS } from "../../src/protocol.ts";
import { pickRequestSchema as pickSchema } from "../../src/schema.ts";

// the 8-byte png signature, as a data url the way modern-screenshot returns one
const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

const selection = {
	component: "PriceCard",
	file: "/src/components/price-card.tsx",
	line: 42,
	column: 7,
	html: '<div class="card">\n  $12\n</div>',
};

test("a pick built from a selection passes the helper's schema", () => {
	const pick = buildPick({
		pickId: newPickId(),
		note: "make the price bold",
		elements: [{ selection, screenshot: PNG_DATA_URL }],
	});
	expect(pickSchema.safeParse(pick).success).toBe(true);
	expect(pick).toMatchObject({
		note: "make the price bold",
		elements: [
			{
				component: "PriceCard",
				file: "/src/components/price-card.tsx",
				line: 42,
				column: 7,
			},
		],
	});
});

test("the screenshot is plain base64, without the data url prefix", () => {
	const pick = buildPick({
		pickId: "p1",
		note: "",
		elements: [{ selection, screenshot: PNG_DATA_URL }],
	});
	expect(pick.elements[0]?.screenshot).toBe("iVBORw0KGgo=");
});

test("no screenshot leaves the field out", () => {
	const pick = buildPick({ pickId: "p1", note: "", elements: [{ selection }] });
	expect(pick.elements[0]).not.toHaveProperty("screenshot");
	expect(pickSchema.safeParse(pick).success).toBe(true);
});

test("an unknown column leaves the field out", () => {
	const { column: _, ...withoutColumn } = selection;
	const pick = buildPick({
		pickId: "p1",
		note: "",
		elements: [{ selection: withoutColumn }],
	});
	expect(pick.elements[0]).not.toHaveProperty("column");
	expect(pickSchema.safeParse(pick).success).toBe(true);
});

test("pick ids are distinct and fit the helper's filename rule", () => {
	const ids = Array.from({ length: 50 }, newPickId);
	for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
	expect(new Set(ids).size).toBe(ids.length);
});

test("a screenshot too big for the dev server's body limit is dropped, not sent", () => {
	const huge = `data:image/png;base64,iVBORw0KGgo${"A".repeat(MAX_SCREENSHOT_CHARS)}`;
	const pick = buildPick({
		pickId: "p1",
		note: "",
		elements: [{ selection, screenshot: huge }],
	});
	expect(pick.elements[0]).not.toHaveProperty("screenshot");
});

test.each([
	["empty, as a zero-size or oversize canvas renders", "data:,"],
	["not a png", "data:image/jpeg;base64,/9j/4AAQSkZJRg=="],
])("a screenshot that's %s is dropped, not sent", (_, screenshot) => {
	const pick = buildPick({
		pickId: "p1",
		note: "",
		elements: [{ selection, screenshot }],
	});
	expect(pick.elements[0]).not.toHaveProperty("screenshot");
	expect(pickSchema.safeParse(pick).success).toBe(true);
});

test("the posted pick carries the module url and react-grab's column counted from 1", () => {
	const moduleUrl = "http://localhost:5173/src/components/price-card.tsx?t=1";
	const picked = toSelection({
		source: {
			filePath: "price-card.tsx",
			lineNumber: 42,
			columnNumber: 0,
			componentName: "PriceCard",
		},
		moduleUrl,
		tagName: "div",
		html: "<div></div>",
	});
	if (!picked) throw new Error("no selection");

	const pick = buildPick({
		pickId: "p1",
		note: "",
		elements: [{ selection: picked }],
	});

	expect(pick.elements).toMatchObject([
		{ file: "price-card.tsx", column: 1, moduleUrl },
	]);
	expect(pickSchema.safeParse(pick).success).toBe(true);
});

test("several elements go out in marker order, each with its own screenshot, and pass the helper's schema", () => {
	const header = { ...selection, component: "Header", line: 7 };
	const footer = { ...selection, component: "Footer", line: 99 };

	const pick = buildPick({
		pickId: "p1",
		note: "put [3] beside [1], under [2]",
		elements: [
			{ selection, screenshot: PNG_DATA_URL },
			{ selection: header },
			{
				selection: footer,
				screenshot: "data:image/png;base64,iVBORw0KGgoAAAA=",
			},
		],
	});

	expect(pickSchema.safeParse(pick).success).toBe(true);
	expect(pick.elements).toMatchObject([
		{ component: "PriceCard", screenshot: "iVBORw0KGgo=" },
		{ component: "Header", line: 7 },
		{ component: "Footer", line: 99, screenshot: "iVBORw0KGgoAAAA=" },
	]);
	expect(pick.elements[1]).not.toHaveProperty("screenshot");
});

test("each element's screenshot is held to its own budget", () => {
	const atBudget = `data:image/png;base64,${"iVBORw0KGgo".padEnd(MAX_SCREENSHOT_CHARS, "A")}`;

	const pick = buildPick({
		pickId: "p1",
		note: "",
		elements: [
			{ selection, screenshot: atBudget },
			{ selection, screenshot: atBudget },
		],
	});

	expect(pick.elements.map((element) => element.screenshot?.length)).toEqual([
		MAX_SCREENSHOT_CHARS,
		MAX_SCREENSHOT_CHARS,
	]);
});
