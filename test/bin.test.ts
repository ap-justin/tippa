import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const BIN = resolve(import.meta.dirname, "../src/channel/bin.ts");

let cwd: string;
let helper: ChildProcess;

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "ui-pick-bin-"));
	helper = spawn(process.execPath, [BIN], {
		cwd,
		stdio: ["pipe", "pipe", "inherit"],
	});
	await vi.waitFor(() => access(join(cwd, ".ui-pick", "channel.json")), {
		timeout: 3000,
	});
});

afterEach(async () => {
	helper.kill("SIGKILL");
	await rm(cwd, { recursive: true, force: true });
});

test.each([
	["SIGTERM", () => helper.kill("SIGTERM")],
	["SIGINT", () => helper.kill("SIGINT")],
	["stdin closing", () => helper.stdin?.end()],
])("the helper removes its discovery file on %s", async (_, stop) => {
	const exited = once(helper, "exit");
	stop();
	const [code] = await exited;
	expect(code).toBe(0);
	await expect(access(join(cwd, ".ui-pick", "channel.json"))).rejects.toThrow(
		"ENOENT",
	);
});
