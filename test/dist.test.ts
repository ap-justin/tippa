import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { AgentAdapter } from "../src/index.ts";

// what a `link:` consumer's vite.config imports; `pnpm check` builds before it tests
const DIST_ENTRY = resolve(import.meta.dirname, "../dist/index.mjs");

let server: ViteDevServer | undefined;
let root: string | undefined;

const SRC = resolve(import.meta.dirname, "../src");
const DIST_CLIENT = resolve(import.meta.dirname, "../dist/client/index.js");

beforeAll(async () => {
	const built = await Promise.all(
		[DIST_ENTRY, DIST_CLIENT].map((file) =>
			stat(file).catch(() => {
				throw new Error(`${file} is missing: run pnpm build first`);
			}),
		),
	);
	const sources = await readdir(SRC, { recursive: true, withFileTypes: true });
	const newestSource = Math.max(
		...(await Promise.all(
			sources
				.filter((entry) => entry.isFile())
				.map(
					async (entry) =>
						(
							await stat(join(entry.parentPath, entry.name))
						).mtimeMs,
				),
		)),
	);
	if (Math.min(...built.map((file) => file.mtimeMs)) < newestSource) {
		throw new Error("dist is older than src: run pnpm build first");
	}
});

afterEach(async () => {
	await server?.close();
	server = undefined;
	if (root) await rm(root, { recursive: true, force: true });
});

const idleAgent: AgentAdapter = {
	label: "Idle",
	connect: () => ({
		status: "waiting",
		onStatus() {},
		onReply() {},
		send: async () => {},
		close: async () => {},
	}),
};

async function getText(url: string): Promise<string> {
	const res = await fetch(url);
	expect(res.status, url).toBe(200);
	return res.text();
}

test("the built plugin serves its built client and every chunk it imports to an app outside the package", async () => {
	vi.stubEnv("VITEST", undefined);
	const { tippa } = (await import(
		pathToFileURL(DIST_ENTRY).href
	)) as typeof import("../src/index.ts");
	root = await mkdtemp(join(tmpdir(), "tippa-consumer-"));
	await writeFile(join(root, "index.html"), "<!doctype html><p>app</p>");
	server = await createServer({
		root,
		configFile: false,
		logLevel: "silent",
		server: { host: "127.0.0.1", port: 0 },
		plugins: [tippa({ agent: idleAgent })],
	});
	await server.listen();
	const address = server.httpServer?.address() as AddressInfo | undefined;
	const origin = `http://127.0.0.1:${address?.port}`;

	const viteClient = await getText(`${origin}/@vite/client`);
	const loaderUrl = viteClient.match(/import\("([^"]*tippa[^"]*)"\)/)?.[1];
	const loader = await getText(`${origin}${loaderUrl}`);
	const clientUrl = loader.match(/from "(\/@fs\/[^"]+)"/)?.[1];
	expect(clientUrl).toMatch(/\/dist\/client\/index\.js$/);

	const client = await getText(`${origin}${clientUrl}`);
	expect(client).toMatch(/export \{[^}]*\bstart\b/);
	const chunks = [
		...client.matchAll(/(?:from |import\()"(\/@fs\/[^"]+)"/g),
	].map((match) => match[1]);
	expect(chunks.length).toBeGreaterThan(0);
	for (const chunk of chunks) await getText(`${origin}${chunk}`);
});
