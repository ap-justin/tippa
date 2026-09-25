import { expect, test } from "vitest";
import { buildPick, newPickId } from "../../src/client/payload.ts";
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
		selection,
		screenshot: PNG_DATA_URL,
	});
	expect(pickSchema.safeParse(pick).success).toBe(true);
	expect(pick).toMatchObject({
		note: "make the price bold",
		component: "PriceCard",
		file: "/src/components/price-card.tsx",
		line: 42,
		column: 7,
	});
});

test("the screenshot is plain base64, without the data url prefix", () => {
	const pick = buildPick({
		pickId: "p1",
		note: "",
		selection,
		screenshot: PNG_DATA_URL,
	});
	expect(pick.screenshot).toBe("iVBORw0KGgo=");
});

test("no screenshot leaves the field out", () => {
	const pick = buildPick({ pickId: "p1", note: "", selection });
	expect("screenshot" in pick).toBe(false);
	expect(pickSchema.safeParse(pick).success).toBe(true);
});

test("an unknown column leaves the field out", () => {
	const { column: _, ...withoutColumn } = selection;
	const pick = buildPick({ pickId: "p1", note: "", selection: withoutColumn });
	expect("column" in pick).toBe(false);
	expect(pickSchema.safeParse(pick).success).toBe(true);
});

test("pick ids are distinct and fit the helper's filename rule", () => {
	const ids = Array.from({ length: 50 }, newPickId);
	for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
	expect(new Set(ids).size).toBe(ids.length);
});

test("a screenshot too big for the dev server's body limit is dropped, not sent", () => {
	const huge = `data:image/png;base64,${"A".repeat(9_000_000)}`;
	const pick = buildPick({
		pickId: "p1",
		note: "",
		selection,
		screenshot: huge,
	});
	expect("screenshot" in pick).toBe(false);
});
