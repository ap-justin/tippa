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
	"server:tippa",
];

const CLAUDE = resolve(import.meta.dirname, "fixtures/claude.mjs");

let cwd: string;
let launcher: ChildProcess;

/** the helper as claude code spawns it: a child of a claude stand-in started with `claudeArgs` */
function spawnUnder(
	claudeArgs: string[],
	dir: string,
	{
		env = process.env,
		stderr = "inherit",
	}: { env?: NodeJS.ProcessEnv; stderr?: "inherit" | "pipe" } = {},
) {
	return spawn(
		process.execPath,
		[CLAUDE, ...claudeArgs, "--run", process.execPath, BIN],
		{ cwd: dir, env, stdio: ["pipe", "pipe", stderr] },
	);
}

function spawnFlagged(dir: string, env: NodeJS.ProcessEnv = process.env) {
	return spawnUnder(CHANNEL_ARGS, dir, { env });
}

async function discoveryIn(dir: string): Promise<Discovery> {
	return vi.waitFor(
		async () =>
			JSON.parse(await readFile(join(dir, ".tippa", "channel.json"), "utf8")),
		{ timeout: 3000 },
	);
}

/** SIGTERM the helper and wait for its stand-in, so its cleanup runs before the next test */
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
	cwd = await mkdtemp(join(tmpdir(), "tippa-bin-"));
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
	await expect(access(join(cwd, ".tippa", "channel.json"))).rejects.toThrow(
		"ENOENT",
	);
	expect(await readdir(join(cwd, ".tippa"))).toEqual([".gitignore"]);
});

test("the helper writes its discovery file under CLAUDE_PROJECT_DIR when claude code sets it", async () => {
	const projectDir = await mkdtemp(join(tmpdir(), "tippa-project-"));
	const nested = await mkdtemp(join(tmpdir(), "tippa-cwd-"));
	const other = spawnFlagged(nested, {
		...process.env,
		CLAUDE_PROJECT_DIR: projectDir,
	});
	try {
		const { pid } = await discoveryIn(projectDir);
		await expect(
			access(join(nested, ".tippa", "channel.json")),
		).rejects.toThrow("ENOENT");
		await stop(other, pid);
	} finally {
		await rm(projectDir, { recursive: true, force: true });
		await rm(nested, { recursive: true, force: true });
	}
});

/** the one child of `pid`, `depth` generations down */
async function descendant(
	pid: number | undefined,
	depth: number,
): Promise<number> {
	let current = Number(pid);
	for (let i = 0; i < depth; i++) {
		const { stdout } = await promisify(execFile)("pgrep", [
			"-P",
			String(current),
		]);
		current = Number(stdout.trim());
	}
	return current;
}

function initialize(child: ChildProcess): Promise<unknown> {
	child.stdin?.write(
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
	return once(child.stdout as NodeJS.ReadableStream, "data").then(([answer]) =>
		JSON.parse(String(answer)),
	);
}

/**
 * spawns the helper under `claudeArgs` and checks it came up inert: one stderr line
 * matching `reason`, an mcp server that answers, no discovery file, no listening port
 */
async function expectInert(
	claudeArgs: string[],
	reason: RegExp,
	{ depth = 1, env }: { depth?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "tippa-inert-"));
	const child = spawnUnder(claudeArgs, dir, {
		stderr: "pipe",
		...(env && { env }),
	});
	try {
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		await vi.waitFor(() => expect(stderr).toMatch(reason), { timeout: 3000 });
		expect(stderr.trim().split("\n")).toHaveLength(1);

		expect(await initialize(child)).toMatchObject({
			id: 1,
			result: { serverInfo: { name: "tippa" } },
		});
		await expect(access(join(dir, ".tippa"))).rejects.toThrow("ENOENT");
		expect(await listeningPorts(await descendant(child.pid, depth))).toEqual(
			[],
		);
	} finally {
		const exited = once(child, "exit");
		child.kill("SIGTERM");
		await exited;
		await rm(dir, { recursive: true, force: true });
	}
}

const NEEDS_FLAG =
	/started with --dangerously-load-development-channels server:tippa/;

test("a helper under a claude started without the channel flag stays an mcp server but writes no discovery file and opens no port", async () => {
	await expectInert([], NEEDS_FLAG);
});

test("a helper under a claude flagged with the package's former server name stays inert", async () => {
	await expectInert(
		["--dangerously-load-development-channels", "server:ui-pick"],
		NEEDS_FLAG,
	);
});

test("a helper under an unflagged claude that a flagged claude started stays inert", async () => {
	await expectInert(
		[...CHANNEL_ARGS, "--run", process.execPath, CLAUDE],
		NEEDS_FLAG,
		{ depth: 2 },
	);
});

test("a helper that can't run ps says so, not that the flag is missing", async () => {
	await expectInert(CHANNEL_ARGS, /couldn't read the process table/, {
		env: { ...process.env, PATH: "" },
	});
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
