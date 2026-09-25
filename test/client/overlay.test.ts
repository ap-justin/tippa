// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { PickController } from "../../src/client/controller.ts";
import { mountOverlay } from "../../src/client/overlay.ts";
import type { Selection } from "../../src/client/payload.ts";
import type { PickRequest } from "../../src/protocol.ts";
import { pickRequestSchema } from "../../src/schema.ts";

const { domToPng } = vi.hoisted(() => ({
	domToPng: vi.fn<typeof import("modern-screenshot").domToPng>(),
}));
vi.mock(import("modern-screenshot"), async (importOriginal) => ({
	...(await importOriginal()),
	domToPng,
}));

// happy-dom has no popover api; the top layer isn't what these tests cover
HTMLElement.prototype.showPopover ??= () => {};

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

const selection: Selection = {
	component: "PriceCard",
	file: "price-card.tsx",
	line: 42,
	column: 8,
	moduleUrl: "http://localhost:5173/src/components/price-card.tsx?t=1",
	html: '<div class="card">$12</div>',
};

afterEach(() => {
	for (const node of document.querySelectorAll("ui-pick-overlay, .picked"))
		node.remove();
	vi.useRealTimers();
});

// Promise.withResolvers is es2024; the client targets es2023
function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function respond(status: number) {
	return vi.fn<typeof fetch>(async () => Response.json({}, { status }));
}

function mount(post = respond(202)) {
	domToPng.mockResolvedValue(PNG_DATA_URL);
	const controller = new PickController(
		{ token: "t0ken", endpoint: "/__ui-pick/pick" },
		post,
	);
	const onPick = mountOverlay(controller);
	const root = document.querySelector("ui-pick-overlay")?.shadowRoot;
	if (!root) throw new Error("overlay not mounted");
	const query = <T extends Element>(selector: string): T => {
		const found = root.querySelector<T>(selector);
		if (!found) throw new Error(`no ${selector}`);
		return found;
	};
	const composer = query<HTMLFormElement>("form");
	const note = query<HTMLTextAreaElement>("textarea");
	const send = query<HTMLButtonElement>('button[type="submit"]');
	const cancel = query<HTMLButtonElement>('button[type="button"]');
	const notice = query<HTMLElement>(".notice");

	function pick(picked: Selection | undefined = selection): Element {
		const element = document.createElement("div");
		element.className = "picked";
		document.body.append(element);
		onPick(element, picked);
		return element;
	}

	function type(text: string): void {
		note.value = text;
		note.dispatchEvent(new Event("input", { bubbles: true }));
	}

	function key(init: KeyboardEventInit): void {
		note.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, composed: true, ...init }),
		);
	}

	function posted(): PickRequest[] {
		return post.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
	}

	return {
		controller,
		post,
		composer,
		note,
		send,
		cancel,
		notice,
		pick,
		type,
		key,
		posted,
	};
}

test("a 503 keeps the box open with the note and says claude isn't connected", async () => {
	const ui = mount(respond(503));
	ui.pick();
	ui.type("make the price bold");

	ui.send.click();

	await vi.waitFor(() =>
		expect(ui.notice.textContent).toBe("Claude isn't connected"),
	);
	expect(ui.composer.hidden).toBe(false);
	expect(ui.note.value).toBe("make the price bold");
	expect(ui.send.disabled).toBe(true);
});

test.each([{ metaKey: true }, { ctrlKey: true }])(
	"%o + Enter sends the note",
	async (modifier) => {
		const ui = mount();
		ui.pick();
		ui.type("bigger");

		ui.key({ key: "Enter", ...modifier });

		await vi.waitFor(() => expect(ui.composer.hidden).toBe(true));
		expect(ui.posted()).toMatchObject([{ note: "bigger" }]);
	},
);

test("Escape closes the box without sending", async () => {
	const ui = mount();
	ui.pick();
	ui.type("bigger");

	ui.key({ key: "Escape" });

	expect(ui.composer.hidden).toBe(true);
	await Promise.resolve();
	expect(ui.post).not.toHaveBeenCalled();
});

test("while claude is waiting, send is off and the box says why", () => {
	const ui = mount();
	ui.controller.handleStatus({ status: "waiting" });

	ui.pick();

	expect(ui.send.disabled).toBe(true);
	expect(ui.notice.textContent).toBe("Claude isn't connected");
});

test("keys pressed mid-composition (IME) neither close nor send", async () => {
	const ui = mount();
	ui.pick();
	ui.type("大き");

	ui.key({ key: "Escape", isComposing: true });
	ui.key({ key: "Enter", metaKey: true, isComposing: true });

	expect(ui.composer.hidden).toBe(false);
	await Promise.resolve();
	expect(ui.post).not.toHaveBeenCalled();
});

test.each([
	["Cancel", (ui: ReturnType<typeof mount>) => ui.cancel.click()],
	["Escape", (ui: ReturnType<typeof mount>) => ui.key({ key: "Escape" })],
])(
	"%s while the screenshot is still rendering posts nothing",
	async (_, close) => {
		const ui = mount();
		const { promise: shot, resolve } = deferred<string>();
		domToPng.mockReturnValue(shot);
		ui.pick();
		ui.type("bigger");
		ui.send.click();

		close(ui);
		resolve(PNG_DATA_URL);

		await new Promise((done) => setTimeout(done, 10));
		expect(ui.post).not.toHaveBeenCalled();
		expect(ui.composer.hidden).toBe(true);
	},
);

test.each([
	["rejects", () => domToPng.mockRejectedValue(new Error("tainted canvas"))],
	["comes back empty", () => domToPng.mockResolvedValue("data:,")],
])("a screenshot that %s still sends, without one", async (_, arrange) => {
	const ui = mount();
	arrange();
	ui.pick();

	ui.send.click();

	await vi.waitFor(() => expect(ui.post).toHaveBeenCalledOnce());
	expect("screenshot" in (ui.posted()[0] ?? {})).toBe(false);
});

test("a screenshot still rendering after 5 s is given up on and the pick sends without it", async () => {
	vi.useFakeTimers();
	const ui = mount();
	domToPng.mockReturnValue(new Promise(() => {}));
	ui.pick();
	ui.send.click();

	await vi.advanceTimersByTimeAsync(4999);
	expect(ui.post).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);

	expect(ui.post).toHaveBeenCalledOnce();
	expect("screenshot" in (ui.posted()[0] ?? {})).toBe(false);
});

test("the screenshot is capped to a canvas size browsers can draw", () => {
	const ui = mount();
	ui.pick();
	expect(domToPng).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ maximumCanvasSize: expect.any(Number) }),
	);
});

test("a 503 answered after claude connected leaves send on to retry", async () => {
	const { promise: response, resolve } = deferred<Response>();
	const ui = mount(vi.fn<typeof fetch>(() => response));
	ui.pick();
	ui.send.click();
	await vi.waitFor(() => expect(ui.post).toHaveBeenCalledOnce());

	ui.controller.handleStatus({ status: "connected" });
	resolve(Response.json({}, { status: 503 }));

	await vi.waitFor(() => expect(ui.controller.picks.size).toBe(0));
	expect(ui.controller.canSend).toBe(true);
	expect(ui.send.disabled).toBe(false);
	expect(ui.notice.textContent).toBe("Claude isn't connected");
	expect(ui.composer.hidden).toBe(false);
});

test("picking again before sending keeps the note", () => {
	const ui = mount();
	ui.pick(undefined);
	ui.type("make the price bold");

	ui.pick();

	expect(ui.note.value).toBe("make the price bold");
	expect(ui.send.disabled).toBe(false);
});

test("picking again after a send starts an empty note", async () => {
	const ui = mount();
	ui.pick();
	ui.type("make the price bold");
	ui.send.click();
	await vi.waitFor(() => expect(ui.composer.hidden).toBe(true));

	ui.pick();

	expect(ui.note.value).toBe("");
});

test("a send that fails after picking something else comes back as the draft, note and error", async () => {
	const { promise: response, resolve } = deferred<Response>();
	const ui = mount(vi.fn<typeof fetch>(() => response));
	ui.pick();
	ui.type("make the price bold");
	ui.send.click();
	await vi.waitFor(() => expect(ui.post).toHaveBeenCalledOnce());
	ui.pick({ ...selection, component: "Header" });
	expect(ui.note.value).toBe("");

	resolve(Response.json({ error: "invalid_pick" }, { status: 400 }));

	await vi.waitFor(() => expect(ui.note.value).toBe("make the price bold"));
	expect(ui.notice.textContent).toBe("Couldn't send (400 invalid_pick)");
	expect(ui.composer.hidden).toBe(false);
	expect(ui.send.disabled).toBe(false);
});

test("the posted pick passes the dev server's schema, screenshot and module url included", async () => {
	const ui = mount();
	ui.pick();
	ui.type("make the price bold");

	ui.send.click();

	await vi.waitFor(() => expect(ui.post).toHaveBeenCalledOnce());
	const [body] = ui.posted();
	expect(pickRequestSchema.safeParse(body).success).toBe(true);
	expect(body).toMatchObject({
		note: "make the price bold",
		column: 8,
		moduleUrl: selection.moduleUrl,
		screenshot: "iVBORw0KGgo=",
	});
});
