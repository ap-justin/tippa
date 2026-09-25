import { expect, test, vi } from "vitest";
import { listen, PickController } from "../../src/client/controller.ts";
import {
	type PickRequest,
	REPLY_EVENT,
	STATUS_EVENT,
} from "../../src/protocol.ts";

const config = { token: "t0ken", endpoint: "/__ui-pick/pick" };

function pick(pickId: string): PickRequest {
	return {
		pickId,
		note: "bigger",
		component: "Card",
		file: "/src/card.tsx",
		line: 3,
		html: "<div></div>",
	};
}

function respond(status: number, body: unknown = {}) {
	return vi.fn<typeof fetch>(async () => Response.json(body, { status }));
}

test("posts the pick with the token header and marks it sent on 202", async () => {
	const post = respond(202, { pickId: "a", status: "sent" });
	const controller = new PickController(config, post);

	const outcome = await controller.send(pick("a"));

	expect(outcome).toEqual({ ok: true });
	expect(controller.picks.get("a")).toEqual({ badge: "sent" });
	const [url, init] = post.mock.calls[0] ?? [];
	expect(url).toBe("/__ui-pick/pick");
	expect(init?.method).toBe("POST");
	expect(new Headers(init?.headers).get("x-ui-pick-token")).toBe("t0ken");
	expect(new Headers(init?.headers).get("content-type")).toBe(
		"application/json",
	);
	expect(JSON.parse(String(init?.body))).toEqual(pick("a"));
});

test("503 reports claude isn't connected and keeps no badge", async () => {
	const controller = new PickController(
		config,
		respond(503, { error: "not_connected" }),
	);
	expect(await controller.send(pick("a"))).toEqual({
		ok: false,
		error: "Claude isn't connected",
	});
	expect(controller.picks.has("a")).toBe(false);
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
	expect(controller.picks.has("a")).toBe(false);
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
	expect(controller.picks.has("a")).toBe(false);
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

test("replies move a pick's badge and fill its bubble", async () => {
	const controller = new PickController(config, respond(202));
	await controller.send(pick("a"));

	controller.handleReply({ pickId: "a", status: "working", message: "" });
	expect(controller.picks.get("a")).toEqual({ badge: "working" });

	controller.handleReply({
		pickId: "a",
		status: "question",
		message: "which blue?",
	});
	expect(controller.picks.get("a")).toEqual({
		badge: "question",
		message: "which blue?",
	});

	controller.handleReply({
		pickId: "a",
		status: "done",
		message: "made it bold",
	});
	expect(controller.picks.get("a")).toEqual({
		badge: "done",
		message: "made it bold",
	});
});

test("two picks resolve independently, in the order replies arrive", async () => {
	const controller = new PickController(config, respond(202));
	await controller.send(pick("a"));
	await controller.send(pick("b"));
	controller.handleReply({ pickId: "a", status: "working", message: "" });

	controller.handleReply({ pickId: "b", status: "done", message: "b done" });
	expect(controller.picks.get("a")).toEqual({ badge: "working" });
	expect(controller.picks.get("b")).toEqual({
		badge: "done",
		message: "b done",
	});

	controller.handleReply({ pickId: "a", status: "done", message: "a done" });
	expect(controller.picks.get("a")).toEqual({
		badge: "done",
		message: "a done",
	});
});

test("a reply for a pick this page didn't send is ignored", () => {
	const controller = new PickController(config, respond(202));
	const listener = vi.fn();
	controller.subscribe(listener);
	controller.handleReply({ pickId: "other-tab", status: "done", message: "" });
	expect(controller.picks.size).toBe(0);
	expect(listener).not.toHaveBeenCalled();
});

test("a reply that lands before the 202 isn't overwritten by sent", async () => {
	let accept: (response: Response) => void = () => {};
	const controller = new PickController(
		config,
		vi.fn<typeof fetch>(() => new Promise((resolve) => (accept = resolve))),
	);
	const sending = controller.send(pick("a"));
	controller.handleReply({ pickId: "a", status: "working", message: "" });
	accept(Response.json({}, { status: 202 }));
	await sending;
	expect(controller.picks.get("a")).toEqual({ badge: "working" });
});

test("sending and replies tell subscribers", async () => {
	const controller = new PickController(config, respond(202));
	const badges: (string | undefined)[] = [];
	controller.subscribe(() => badges.push(controller.picks.get("a")?.badge));
	await controller.send(pick("a"));
	controller.handleReply({ pickId: "a", status: "done", message: "ok" });
	expect(badges).toEqual(["sending", "sent", "done"]);
});

test("listen feeds the dev server's status and reply events to the controller", async () => {
	const handlers = new Map<string, (payload: never) => void>();
	const hot = {
		on: (event: string, cb: (payload: never) => void) =>
			handlers.set(event, cb),
	};
	const controller = new PickController(config, respond(202));
	listen(hot, controller);
	await controller.send(pick("a"));

	handlers.get(STATUS_EVENT)?.({ status: "waiting" } as never);
	handlers.get(REPLY_EVENT)?.({
		pickId: "a",
		status: "done",
		message: "ok",
	} as never);

	expect(controller.canSend).toBe(false);
	expect(controller.picks.get("a")).toEqual({ badge: "done", message: "ok" });
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
