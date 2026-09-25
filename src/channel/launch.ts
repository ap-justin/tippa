import { execFile } from "node:child_process";
import { promisify } from "node:util";

const CHANNEL_FLAG = "--dangerously-load-development-channels";
// claude, or a launcher such as `pnpm exec` / `npx` between claude and the helper
const MAX_ANCESTORS = 4;

export interface ProcessInfo {
	ppid: number;
	args: string;
}

export type ReadProcess = (pid: number) => Promise<ProcessInfo | undefined>;

/**
 * whether an ancestor claude was started with `--dangerously-load-development-channels server:<name>`.
 * claude code's initialize request is the same with or without the flag, so its command line is the only sign
 */
export async function isLoadedAsChannel(
	name: string,
	pid: number = process.ppid,
	readProcess: ReadProcess = readProcessWithPs,
): Promise<boolean> {
	for (let depth = 0; depth < MAX_ANCESTORS && pid > 1; depth++) {
		const info = await readProcess(pid);
		if (!info) return false;
		if (namesChannel(info.args.split(/\s+/), `server:${name}`)) return true;
		pid = info.ppid;
	}
	return false;
}

/** the flag takes the space-separated entries up to the next option, or one `=` value */
function namesChannel(args: string[], entry: string): boolean {
	for (const [index, arg] of args.entries()) {
		if (arg === `${CHANNEL_FLAG}=${entry}`) return true;
		if (arg !== CHANNEL_FLAG) continue;
		for (const value of args.slice(index + 1)) {
			if (value.startsWith("-")) break;
			if (value === entry) return true;
		}
	}
	return false;
}

const execFileAsync = promisify(execFile);

async function readProcessWithPs(
	pid: number,
): Promise<ProcessInfo | undefined> {
	try {
		const { stdout } = await execFileAsync("ps", [
			"-o",
			"ppid=,args=",
			"-p",
			String(pid),
		]);
		const match = /^\s*(\d+)\s+(.*)$/s.exec(stdout.trim());
		return match ? { ppid: Number(match[1]), args: match[2] ?? "" } : undefined;
	} catch {
		return undefined;
	}
}
