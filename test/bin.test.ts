import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Discovery } from "../src/channel/discovery.ts";

const BIN = resolve(import.meta.dirname, "../src/channel/bin.ts");
const CHANNEL_ARGS = [
	"--dangerously-load-development-channels",
	"server:ui-pick",
];

let cwd: string;
let launcher: ChildProcess;

/**
 * the helper as claude code spawns it: a child of a process started with the channel flag.
 * `sh` stands in for claude and stays the parent, since `; exit` keeps it from exec'ing node
 */
function spawnFlagged(dir: string, env: NodeJS.ProcessEnv = process.env) {
	return spawn(
		"sh",
		[
			"-c",
			`"${process.execPath}" "${BIN}"; exit $?`,
			"claude",
			...CHANNEL_ARGS,
		],
		{ cwd: dir, env, stdio: ["pipe", "pipe", "inherit"] },
	);
}

async function discoveryIn(dir: string): Promise<Discovery> {
	return vi.waitFor(
		async () =>
			JSON.parse(await readFile(join(dir, ".ui-pick", "channel.json"), "utf8")),
		{ timeout: 3000 },
	);
}

/** SIGTERM the helper and wait for its launcher, so its cleanup runs before the next test */
async function stop(child: ChildProcess, helperPid: number): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit");
	try {
		process.kill(helperPid, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
	await exited;
}

let helperPid: number;

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "ui-pick-bin-"));
	launcher = spawnFlagged(cwd);
	helperPid = (await discoveryIn(cwd)).pid;
});

afterEach(async () => {
	await stop(launcher, helperPid);
	await rm(cwd, { recursive: true, force: true });
});

test.each([
	["SIGTERM", () => process.kill(helperPid, "SIGTERM")],
	["SIGINT", () => process.kill(helperPid, "SIGINT")],
	["SIGHUP", () => process.kill(helperPid, "SIGHUP")],
	["stdin closing", () => launcher.stdin?.end()],
])("the helper removes its discovery file on %s", async (_, stopHelper) => {
	const exited = once(launcher, "exit");
	stopHelper();
	const [code] = await exited;
	expect(code).toBe(0);
	await expect(access(join(cwd, ".ui-pick", "channel.json"))).rejects.toThrow(
		"ENOENT",
	);
	expect(await readdir(join(cwd, ".ui-pick"))).toEqual([".gitignore"]);
});

test("the helper writes its discovery file under CLAUDE_PROJECT_DIR when claude code sets it", async () => {
	const projectDir = await mkdtemp(join(tmpdir(), "ui-pick-project-"));
	const nested = await mkdtemp(join(tmpdir(), "ui-pick-cwd-"));
	const other = spawnFlagged(nested, {
		...process.env,
		CLAUDE_PROJECT_DIR: projectDir,
	});
	try {
		const { pid } = await discoveryIn(projectDir);
		await expect(
			access(join(nested, ".ui-pick", "channel.json")),
		).rejects.toThrow("ENOENT");
		await stop(other, pid);
	} finally {
		await rm(projectDir, { recursive: true, force: true });
		await rm(nested, { recursive: true, force: true });
	}
});

test("a helper under a claude started without the channel flag stays an mcp server but writes no discovery file and opens no port", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ui-pick-unflagged-"));
	const unflagged = spawn(process.execPath, [BIN], {
		cwd: dir,
		stdio: ["pipe", "pipe", "pipe"],
	});
	try {
		let stderr = "";
		unflagged.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		await vi.waitFor(
			() =>
				expect(stderr).toMatch(
					/--dangerously-load-development-channels server:ui-pick/,
				),
			{ timeout: 3000 },
		);
		expect(stderr.trim().split("\n")).toHaveLength(1);

		unflagged.stdin.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-11-25",
					capabilities: {},
					clientInfo: { name: "test", version: "0" },
				},
			})}\n`,
		);
		const [answer] = await once(unflagged.stdout, "data");
		expect(JSON.parse(String(answer))).toMatchObject({
			id: 1,
			result: { serverInfo: { name: "ui-pick" } },
		});

		await expect(access(join(dir, ".ui-pick"))).rejects.toThrow("ENOENT");
		expect(await listeningPorts(unflagged.pid)).toEqual([]);
	} finally {
		const exited = once(unflagged, "exit");
		unflagged.kill("SIGTERM");
		await exited;
		await rm(dir, { recursive: true, force: true });
	}
});

test("the flagged helper's listener shows up where the unflagged test looks", async () => {
	const { port } = await discoveryIn(cwd);
	expect(await listeningPorts(helperPid)).toEqual([`127.0.0.1:${port}`]);
});

/** tcp ports `pid` listens on, as lsof names them */
async function listeningPorts(pid: number | undefined): Promise<string[]> {
	try {
		const { stdout } = await promisify(execFile)("lsof", [
			"-a",
			"-p",
			String(pid),
			"-iTCP",
			"-sTCP:LISTEN",
			"-Fn",
			"-nP",
		]);
		return stdout
			.split("\n")
			.filter((line) => line.startsWith("n"))
			.map((line) => line.slice(1));
	} catch (error) {
		// lsof exits 1 when it finds nothing
		if ((error as { code?: unknown }).code === 1) return [];
		throw error;
	}
}
