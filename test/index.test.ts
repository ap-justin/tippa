import { expect, test } from "vitest";

test("public entry exposes the plugin and the claude session adapter", async () => {
	expect(Object.keys(await import("../src/index.ts")).sort()).toEqual([
		"claudeSession",
		"uiPick",
	]);
});
