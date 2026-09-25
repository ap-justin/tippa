import { expect, test } from "vitest";

test("public entry exposes no exports yet", async () => {
	expect(Object.keys(await import("../src/index.ts"))).toEqual([]);
});
