import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** constant-time check of a shared-secret request header */
export function hasSecretHeader(
	req: IncomingMessage,
	header: string,
	secret: string,
): boolean {
	const given = req.headers[header];
	if (typeof given !== "string") return false;
	// hashing first gives equal-length buffers, so a length mismatch leaks nothing
	const digest = (value: string) => createHash("sha256").update(value).digest();
	return timingSafeEqual(digest(given), digest(secret));
}

export function sendJson(
	res: ServerResponse,
	status: number,
	body: unknown,
): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

/** resolves undefined once the body passes `limit`, after draining the rest */
export async function readBody(
	req: IncomingMessage,
	limit: number,
): Promise<string | undefined> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req as AsyncIterable<Buffer>) {
		size += chunk.length;
		if (size <= limit) chunks.push(chunk);
	}
	return size > limit ? undefined : Buffer.concat(chunks).toString("utf8");
}

/** the browser went away mid-request: nothing to answer and nothing to report */
export function isClientAbort(req: IncomingMessage): boolean {
	return req.destroyed && !req.complete;
}
