import { expect, test } from "vitest";
import { channelLaunch } from "../src/channel/launch.ts";

/** a process table: pid → [ppid, argv] */
function table(entries: Record<number, [number, string[]]>) {
	return async (pid: number) => {
		const entry = entries[pid];
		return entry && { ppid: entry[0], argv: entry[1] };
	};
}

const FLAG = "--dangerously-load-development-channels";

test.each([
	["the parent claude carries the flag", ["claude", FLAG, "server:tippa"]],
	["the flag uses =", ["claude", `${FLAG}=server:tippa`]],
	[
		"tippa is one of several entries",
		["claude", FLAG, "plugin:x@y", "server:tippa", "--model", "opus"],
	],
	[
		"claude runs from node",
		["node", "/opt/claude/cli.js", FLAG, "server:tippa"],
	],
])("loaded as a channel when %s", async (_, argv) => {
	expect(await channelLaunch("tippa", 10, table({ 10: [1, argv] }))).toBe(
		"channel",
	);
});

test.each([
	["sh -c", ["sh", "-c", "node bin.mjs"]],
	["npm exec", ["npm", "exec", "tippa-channel"]],
	[
		"pnpm run by node",
		["node", "/usr/local/bin/pnpm", "exec", "tippa-channel"],
	],
	[
		"npx's cli script",
		["node", "/usr/lib/node_modules/npm/bin/npx-cli.js", "tippa-channel"],
	],
])(
	"a %s launcher between claude and the helper is looked past",
	async (_, launcher) => {
		const processes = table({
			10: [20, launcher],
			20: [1, ["claude", FLAG, "server:tippa"]],
		});
		expect(await channelLaunch("tippa", 10, processes)).toBe("channel");
	},
);

test.each([
	["claude has no flag", ["claude"]],
	["the flag names another server", ["claude", FLAG, "server:tippa-other"]],
	[
		"tippa follows another option, not the flag",
		["claude", FLAG, "server:a", "--add-dir", "server:tippa"],
	],
	[
		"tippa is on --channels, which ignores server: entries",
		["claude", "--channels", "server:tippa"],
	],
])("not loaded as a channel when %s", async (_, argv) => {
	expect(await channelLaunch("tippa", 10, table({ 10: [1, argv] }))).toBe(
		"no_flag",
	);
});

test("an unflagged claude started from a flagged one is judged on its own argv", async () => {
	const nested = table({
		10: [11, ["claude", "-p", "summarize"]],
		11: [12, ["zsh", "-c", "claude -p summarize"]],
		12: [1, ["claude", FLAG, "server:tippa"]],
	});
	expect(await channelLaunch("tippa", 10, nested)).toBe("no_flag");
});

test("a shell without -c is not a launcher: an interactive shell is where claude was typed", async () => {
	const processes = table({
		10: [11, ["zsh"]],
		11: [1, ["claude", FLAG, "server:tippa"]],
	});
	expect(await channelLaunch("tippa", 10, processes)).toBe("no_flag");
});

test("a process table that can't be read is its own result", async () => {
	expect(await channelLaunch("tippa", 10, table({}))).toBe("unreadable");
	const launcherOnly = table({ 10: [11, ["sh", "-c", "node bin.mjs"]] });
	expect(await channelLaunch("tippa", 10, launcherOnly)).toBe("unreadable");
});
