import { expect, test } from "vitest";
import { isLoadedAsChannel } from "../src/channel/launch.ts";

/** a process table: pid → [ppid, args] */
function table(entries: Record<number, [number, string]>) {
	return async (pid: number) => {
		const entry = entries[pid];
		return entry && { ppid: entry[0], args: entry[1] };
	};
}

const FLAG = "--dangerously-load-development-channels";

test.each([
	["the parent claude carries the flag", `claude ${FLAG} server:ui-pick`],
	["the flag uses =", `claude ${FLAG}=server:ui-pick`],
	[
		"ui-pick is one of several entries",
		`claude ${FLAG} plugin:x@y server:ui-pick --model opus`,
	],
	["claude runs from node", `node /opt/claude/cli.js ${FLAG} server:ui-pick`],
])("loaded as a channel when %s", async (_, args) => {
	expect(await isLoadedAsChannel("ui-pick", 10, table({ 10: [1, args] }))).toBe(
		true,
	);
});

test("a wrapper between claude and the helper is looked past", async () => {
	const processes = table({
		10: [
			20,
			"node /usr/lib/node_modules/pnpm/bin/pnpm.cjs exec ui-pick-channel",
		],
		20: [1, `claude ${FLAG} server:ui-pick`],
	});
	expect(await isLoadedAsChannel("ui-pick", 10, processes)).toBe(true);
});

test.each([
	["claude has no flag", "claude"],
	["the flag names another server", `claude ${FLAG} server:ui-pick-other`],
	[
		"ui-pick follows another option, not the flag",
		`claude ${FLAG} server:a --add-dir server:ui-pick`,
	],
	[
		"ui-pick is on --channels, which ignores server: entries",
		"claude --channels server:ui-pick",
	],
])("not loaded as a channel when %s", async (_, args) => {
	expect(await isLoadedAsChannel("ui-pick", 10, table({ 10: [1, args] }))).toBe(
		false,
	);
});

test("the walk stops a few levels up, at a process it can't read", async () => {
	const deep = table({
		10: [11, "sh"],
		11: [12, "sh"],
		12: [13, "sh"],
		13: [14, "sh"],
		14: [1, `claude ${FLAG} server:ui-pick`],
	});
	expect(await isLoadedAsChannel("ui-pick", 10, deep)).toBe(false);
	expect(await isLoadedAsChannel("ui-pick", 10, table({}))).toBe(false);
});
