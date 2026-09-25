import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const CHANNEL_FLAG = "--dangerously-load-development-channels";
// a chain of launchers longer than this is not a way anyone starts the helper
const MAX_LAUNCHERS = 4;

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
// npm and npx retitle their process, so ps shows these as the program
const EXEC_SHIMS = new Set(["npm", "npx", "pnpm", "pnpx", "yarn", "bunx"]);
// the same shims when ps shows them as node running a script
const EXEC_SHIM_SCRIPTS = new Set([
	...EXEC_SHIMS,
	"npm-cli.js",
	"npx-cli.js",
	"pnpm.cjs",
	"pnpm.mjs",
	"yarn.js",
	"yarn.cjs",
]);

export interface ProcessInfo {
	ppid: number;
	argv: string[];
}

export type ReadProcess = (pid: number) => Promise<ProcessInfo | undefined>;

export type ChannelLaunch = "channel" | "no_flag" | "unreadable";

/**
 * whether the claude that spawned the helper was started with
 * `--dangerously-load-development-channels server:<name>`. claude code's initialize request is
 * the same with or without the flag, so its command line is the only sign.
 * launchers between the two are looked past; the first other process is judged alone,
 * so an unflagged claude started from inside a flagged session stays unflagged
 */
export async function channelLaunch(
	name: string,
	pid: number = process.ppid,
	readProcess: ReadProcess = readProcessWithPs,
): Promise<ChannelLaunch> {
	for (let depth = 0; depth <= MAX_LAUNCHERS; depth++) {
		const info = await readProcess(pid);
		if (!info) return "unreadable";
		if (!isLauncher(info.argv)) {
			return namesChannel(info.argv, `server:${name}`) ? "channel" : "no_flag";
		}
		pid = info.ppid;
	}
	return "no_flag";
}

function isLauncher([program = "", script = "", ...rest]: string[]): boolean {
	const name = basename(program);
	if (SHELLS.has(name)) return script === "-c" || rest.includes("-c");
	if (EXEC_SHIMS.has(name)) return true;
	return name === "node" && EXEC_SHIM_SCRIPTS.has(basename(script));
}

/** the flag takes the entries up to the next option, or one `=` value */
function namesChannel(argv: string[], entry: string): boolean {
	for (const [index, arg] of argv.entries()) {
		if (arg === `${CHANNEL_FLAG}=${entry}`) return true;
		if (arg !== CHANNEL_FLAG) continue;
		for (const value of argv.slice(index + 1)) {
			if (value.startsWith("-")) break;
			if (value === entry) return true;
		}
	}
	return false;
}

const execFileAsync = promisify(execFile);

/** ps joins argv with spaces, so an argument holding a space reads as several */
async function readProcessWithPs(
	pid: number,
): Promise<ProcessInfo | undefined> {
	try {
		// -ww: never cut a long command line to the terminal's width
		const { stdout } = await execFileAsync("ps", [
			"-ww",
			"-o",
			"ppid=,args=",
			"-p",
			String(pid),
		]);
		const match = /^\s*(\d+)\s+(.*)$/s.exec(stdout.trim());
		if (!match) return undefined;
		return { ppid: Number(match[1]), argv: (match[2] ?? "").split(/\s+/) };
	} catch {
		return undefined;
	}
}
