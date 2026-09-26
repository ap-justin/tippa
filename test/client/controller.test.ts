import { expect, test, vi } from "vitest";
import { listen, PickController } from "../../src/client/controller.ts";
import { type PickRequest, STATUS_EVENT } from "../../src/protocol.ts";

const config = { token: "t0ken", endpoint: "/__tippa/pick" };

function pick(pickId: string): PickRequest {
	return {
		pickId,
		note: "bigger",
		elements: [
			{
				component: "Card",
				file: "/src/card.tsx",
				line: 3,
				html: "<div></div>",
			},
		],
	};
}

function respond(status: number, body: unknown = {}) {
	return vi.fn<typeof fetch>(async () => Response.json(body, { status }));
}

test("posts the pick with the token header and reports a 202 as sent", async () => {
	const post = respond(202, { pickId: "a", status: "sent" });
	const controller = new PickController(config, post);

	const outcome = await controller.send(pick("a"));

	expect(outcome).toEqual({ ok: true });
	const [url, init] = post.mock.calls[0] ?? [];
	expect(url).toBe("/__tippa/pick");
	expect(init?.method).toBe("POST");
	expect(new Headers(init?.headers).get("x-tippa-token")).toBe("t0ken");
	expect(new Headers(init?.headers).get("content-type")).toBe(
		"application/json",
	);
	expect(JSON.parse(String(init?.body))).toEqual(pick("a"));
});

test("503 reports claude isn't connected", async () => {
	const controller = new PickController(
		config,
		respond(503, { error: "not_connected" }),
	);
	expect(await controller.send(pick("a"))).toEqual({
		ok: false,
		error: "Claude isn't connected",
	});
});

test.each([
	[
		400,
		{ error: "invalid_pick", message: "line: expected a number" },
		"Couldn't send (400 invalid_pick): line: expected a number",
	],
	[401, { error: "unauthorized" }, "Couldn't send (401 unauthorized)"],
	[502, "bad gateway", "Couldn't send (502)"],
])("status %i reads as an error in the box", async (status, body, error) => {
	const controller = new PickController(config, respond(status, body));
	expect(await controller.send(pick("a"))).toEqual({ ok: false, error });
});

test("a request that never reaches the dev server reads as an error", async () => {
	const controller = new PickController(
		config,
		vi.fn<typeof fetch>(async () => {
			throw new TypeError("Failed to fetch");
		}),
	);
	expect(await controller.send(pick("a"))).toEqual({
		ok: false,
		error: "Couldn't reach the dev server: Failed to fetch",
	});
});

test("while claude is waiting, sending is off and the box says why", () => {
	const controller = new PickController(config, respond(202));
	expect(controller.canSend).toBe(true);

	controller.handleStatus({ status: "waiting" });
	expect(controller.canSend).toBe(false);
	expect(controller.notice).toBe("Claude isn't connected");

	controller.handleStatus({ status: "connected" });
	expect(controller.canSend).toBe(true);
	expect(controller.notice).toBeUndefined();
});

test("status changes tell subscribers", () => {
	const controller = new PickController(config, respond(202));
	const listener = vi.fn();
	const unsubscribe = controller.subscribe(listener);
	controller.handleStatus({ status: "waiting" });
	expect(listener).toHaveBeenCalledTimes(1);
	unsubscribe();
	controller.handleStatus({ status: "connected" });
	expect(listener).toHaveBeenCalledTimes(1);
});

test("listen feeds the dev server's status events to the controller, and nothing else", () => {
	const handlers = new Map<string, (payload: never) => void>();
	const hot = {
		on: (event: string, cb: (payload: never) => void) =>
			handlers.set(event, cb),
	};
	const controller = new PickController(config, respond(202));
	listen(hot, controller);

	handlers.get(STATUS_EVENT)?.({ status: "waiting" } as never);

	expect([...handlers.keys()]).toEqual([STATUS_EVENT]);
	expect(controller.canSend).toBe(false);
});

test("a 503 turns sending off until claude connects", async () => {
	const controller = new PickController(
		config,
		respond(503, { error: "not_connected" }),
	);
	await controller.send(pick("a"));
	expect(controller.canSend).toBe(false);
	expect(controller.notice).toBe("Claude isn't connected");
	controller.handleStatus({ status: "connected" });
	expect(controller.canSend).toBe(true);
});

test("a 503 tells subscribers that sending is off", async () => {
	const controller = new PickController(
		config,
		respond(503, { error: "not_connected" }),
	);
	const canSend: boolean[] = [];
	controller.subscribe(() => canSend.push(controller.canSend));
	await controller.send(pick("a"));
	expect(canSend).toEqual([false]);
});
