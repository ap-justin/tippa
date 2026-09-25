import { readFileSync, rmSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** `.ui-pick/channel.json`: where the plugin finds the helper */
export const discoverySchema = z.object({
	port: z.number().int().positive(),
	secret: z.string().min(1),
	pid: z.number().int().positive(),
});

export type Discovery = z.output<typeof discoverySchema>;

/** `<cwd>/.ui-pick`, the helper's state: discovery file and screenshots */
export function stateDir(cwd: string): string {
	return join(cwd, ".ui-pick");
}

export function discoveryPath(cwd: string): string {
	return join(stateDir(cwd), "channel.json");
}

/** creates the state dir if it's gone, ignored by the app's git: it holds a live secret */
export async function prepareStateDir(cwd: string): Promise<void> {
	await mkdir(stateDir(cwd), { recursive: true });
	await writeFile(join(stateDir(cwd), ".gitignore"), "*\n");
}

export async function writeDiscovery(
	cwd: string,
	discovery: Discovery,
): Promise<void> {
	const path = discoveryPath(cwd);
	await prepareStateDir(cwd);
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
