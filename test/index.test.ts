import { expect, test } from "vitest";

test("public entry exposes the plugin, the claude session adapter and its error", async () => {
	expect(Object.keys(await import("../src/index.ts")).sort()).toEqual([
		"AgentNotConnectedError",
		"claudeSession",
		"tippa",
	]);
});
