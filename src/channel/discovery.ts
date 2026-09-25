import { readFileSync, rmSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Discovery {
	port: number;
	secret: string;
	pid: number;
}

export function discoveryPath(cwd: string): string {
	return join(cwd, ".ui-pick", "channel.json");
}

export async function writeDiscovery(
	cwd: string,
	discovery: Discovery,
): Promise<void> {
	const path = discoveryPath(cwd);
	await mkdir(join(cwd, ".ui-pick"), { recursive: true });
	const tmp = `${path}.${discovery.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(discovery), { mode: 0o600 });
	await rename(tmp, path);
}

/**
 * removes the file only while it still holds `secret`: a second helper started
 * in the same project overwrites it, and its file must outlive this one.
 */
export function removeDiscovery(cwd: string, secret: string): void {
	const path = discoveryPath(cwd);
	try {
		const current: Partial<Discovery> | null = JSON.parse(
			readFileSync(path, "utf8"),
		);
		if (current?.secret === secret) rmSync(path, { force: true });
	} catch {
		// already gone or unreadable: nothing of ours to remove
	}
}
