// @vitest-environment happy-dom
import type { Options } from "modern-screenshot";
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

// happy-dom has no popover api: record what the overlay asks of the top layer
const popoverCalls: boolean[] = [];
HTMLElement.prototype.togglePopover = (force?: boolean) => {
	popoverCalls.push(force ?? true);
	return force ?? true;
};

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
	for (const node of document.querySelectorAll(
		"ui-pick-overlay, .picked, .page, .modal",
	))
		node.remove();
	popoverCalls.length = 0;
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

// past the capture race and the post: a few microtasks, all ahead of a 0 ms timer
function settle(): Promise<void> {
	return new Promise((done) => setTimeout(done, 0));
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
	const overlay = mountOverlay(controller);
	const host = document.querySelector<HTMLElement>("ui-pick-overlay");
	const root = host?.shadowRoot;
	if (!host || !root) throw new Error("overlay not mounted");
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

	function pick(
		picked: Selection | undefined = selection,
		parent: Element = document.body,
	): HTMLElement {
		const element = document.createElement("div");
		element.className = "picked";
		parent.append(element);
		overlay.pick(element, picked);
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

	/** picks, types and sends; resolves with the sent pick's id once the box closes */
	async function sendPick(text = "make the price bold", picked = selection) {
		const element = pick(picked);
		type(text);
		send.click();
		await vi.waitFor(() => expect(composer.hidden).toBe(true));
		const pickId = posted().at(-1)?.pickId;
		if (!pickId) throw new Error("nothing posted");
		return { pickId, element };
	}

	function posted(): PickRequest[] {
		return post.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
	}

	return {
		overlay,
		host,
		root,
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
		sendPick,
		posted,
		markers: () => [...root.querySelectorAll<HTMLElement>(".pick")],
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
	await settle();
	expect(ui.post).not.toHaveBeenCalled();
});

test("while claude is waiting, send is off and the box says why", () => {
	const ui = mount();
	ui.controller.handleStatus({ status: "waiting" });

	ui.pick();

	expect(ui.send.disabled).toBe(true);
	expect(ui.notice.textContent).toBe("Claude isn't connected");
});

test("Escape mid-composition (IME) leaves the box open", () => {
	const ui = mount();
	ui.pick();
	ui.type("大き");

	ui.key({ key: "Escape", isComposing: true });

	expect(ui.composer.hidden).toBe(false);
});

test("Cmd+Enter mid-composition (IME) doesn't send", async () => {
	const ui = mount();
	ui.pick();
	ui.type("大き");

	ui.key({ key: "Enter", metaKey: true, isComposing: true });

	expect(ui.send.disabled).toBe(false);
	await settle();
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

test("the screenshot is capped to a canvas size browsers can draw, and a slow asset is skipped before the 5 s deadline", () => {
	const ui = mount();
	ui.pick();
	// the mock's type is domToPng's last overload, (context); this call used (node, options)
	const [, options] = (domToPng.mock.calls[0] ?? []) as unknown as [
		Node,
		Options?,
	];
	expect(options).toMatchObject({ maximumCanvasSize: 10_000 });
	expect(options?.timeout).toBeLessThan(5000);
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
	expect(ui.notice.textContent).toBe("Couldn't reach Claude. Send again.");
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

test("a pick after the app's root re-render removed the overlay puts it back in the top layer", () => {
	const ui = mount();
	ui.host.remove();
	popoverCalls.length = 0;

	ui.pick();

	expect(ui.host.isConnected).toBe(true);
	expect(popoverCalls.at(-1)).toBe(true);
	expect(ui.composer.hidden).toBe(false);
});

test("each pick re-raises the overlay to the top of the top layer", () => {
	const ui = mount();
	popoverCalls.length = 0;

	ui.pick();

	expect(popoverCalls).toEqual([false, true]);
});

test("a reply after the overlay was removed puts it back with its marker", async () => {
	const ui = mount();
	ui.pick();
	ui.send.click();
	await vi.waitFor(() => expect(ui.composer.hidden).toBe(true));
	const [{ pickId } = { pickId: "" }] = ui.posted();
	ui.host.remove();

	ui.controller.handleReply({
		pickId,
		status: "done",
		message: "made it bold",
	});

	expect(ui.host.isConnected).toBe(true);
	expect(popoverCalls.at(-1)).toBe(true);
	expect(ui.root.querySelector(".bubble")?.textContent).toBe("made it bold");
});

test("a dismissed marker stays gone until claude replies to its pick again", async () => {
	const ui = mount();
	const { pickId } = await ui.sendPick();
	ui.controller.handleReply({ pickId, status: "working", message: "" });
	ui.markers()[0]?.querySelector<HTMLButtonElement>(".dismiss")?.click();
	expect(ui.markers()).toHaveLength(0);

	ui.controller.handleStatus({ status: "connected" });
	expect(ui.markers()).toHaveLength(0);

	ui.controller.handleReply({
		pickId,
		status: "question",
		message: "which price?",
	});
	expect(ui.markers()).toHaveLength(1);
	expect(ui.markers()[0]?.querySelector(".bubble")?.textContent).toBe(
		"which price?",
	);
});

function focusedPageButton(): HTMLButtonElement {
	const button = document.createElement("button");
	button.className = "page";
	document.body.append(button);
	button.focus();
	return button;
}

test.each([
	["Escape", (ui: ReturnType<typeof mount>) => ui.key({ key: "Escape" })],
	["Cancel", (ui: ReturnType<typeof mount>) => ui.cancel.click()],
	[
		"a successful send",
		async (ui: ReturnType<typeof mount>) => {
			ui.send.click();
			await vi.waitFor(() => expect(ui.composer.hidden).toBe(true));
		},
	],
])("%s gives focus back to where it was before the pick", async (_, close) => {
	const ui = mount();
	const before = focusedPageButton();
	ui.pick();
	expect(ui.root.activeElement).toBe(ui.note);

	await close(ui);

	expect(document.activeElement).toBe(before);
});

test("pressing Send keeps keyboard focus in the box while it sends", async () => {
	const { promise: response, resolve } = deferred<Response>();
	const ui = mount(vi.fn<typeof fetch>(() => response));
	ui.pick();
	ui.send.focus();

	ui.send.click();

	expect(ui.send.disabled).toBe(true);
	expect(ui.root.activeElement).toBe(ui.note);
	resolve(Response.json({}, { status: 202 }));
});

test("the note is described by its target line and the notice, which is rendered while empty", () => {
	const ui = mount();
	ui.pick();

	const described = ui.note
		.getAttribute("aria-describedby")
		?.split(" ")
		.map((id) => ui.root.getElementById(id));
	expect(described).toEqual([ui.root.querySelector(".target"), ui.notice]);
	expect(ui.notice.textContent).toBe("");
	expect(ui.notice.getAttribute("role")).toBe("status");
	expect(getComputedStyle(ui.notice).display).not.toBe("none");
});

test("a reply rewrites only its own marker, so other markers aren't announced again", async () => {
	const ui = mount();
	const a = await ui.sendPick("bold");
	const b = await ui.sendPick("red", { ...selection, component: "Header" });
	ui.controller.handleReply({
		pickId: a.pickId,
		status: "done",
		message: "made it bold",
	});
	const [markerA] = ui.markers();
	if (!markerA) throw new Error("no marker");
	const changes = new MutationObserver(() => {});
	changes.observe(markerA, {
		subtree: true,
		childList: true,
		characterData: true,
		attributes: true,
	});

	ui.controller.handleReply({
		pickId: b.pickId,
		status: "working",
		message: "",
	});
	ui.controller.handleStatus({ status: "connected" });

	expect(changes.takeRecords()).toEqual([]);
});

test("each dismiss button is named for its pick", async () => {
	const ui = mount();
	await ui.sendPick();

	const dismiss = ui.markers()[0]?.querySelector("button");
	expect(dismiss?.getAttribute("aria-label")).toBe(
		"Dismiss reply for PriceCard",
	);
});

test.each(["keydown", "keyup", "keypress"])(
	"%s while typing a note doesn't reach the page's shortcut listeners",
	(type) => {
		const ui = mount();
		const pageShortcut = vi.fn();
		document.addEventListener(type, pageShortcut);
		ui.pick();

		ui.note.dispatchEvent(
			new KeyboardEvent(type, { key: "k", bubbles: true, composed: true }),
		);

		document.removeEventListener(type, pageShortcut);
		expect(pageShortcut).not.toHaveBeenCalled();
	},
);

test("a send that fails while another note is being typed keeps that note and shows the failure on its marker", async () => {
	const { promise: response, resolve } = deferred<Response>();
	const ui = mount(vi.fn<typeof fetch>(() => response));
	ui.pick();
	ui.type("make the price bold");
	ui.send.click();
	await vi.waitFor(() => expect(ui.post).toHaveBeenCalledOnce());
	ui.pick({ ...selection, component: "Header" });
	ui.type("make it red");

	resolve(Response.json({ error: "invalid_pick" }, { status: 400 }));

	await vi.waitFor(() =>
		expect(ui.root.querySelector(".badge")?.textContent).toBe("not sent"),
	);
	expect(ui.note.value).toBe("make it red");
	expect(ui.root.querySelector(".target")?.textContent).toMatch(/^Header/);
	expect(ui.markers()).toHaveLength(1);
	const [marker] = ui.markers();
	expect(marker?.querySelector(".bubble")?.textContent).toBe(
		"Couldn't send (400 invalid_pick)\nmake the price bold",
	);
	expect(marker?.querySelector("button")?.getAttribute("aria-label")).toBe(
		"Dismiss reply for PriceCard",
	);
});

/** real frames; happy-dom runs rAF callbacks off its timers */
function frames(count: number): Promise<void> {
	return new Promise((done) => setTimeout(done, 20 * count));
}

test.each(["working", "question", "done"] as const)(
	"with the box closed, a %s marker isn't measured every frame",
	async (status) => {
		const ui = mount();
		const { pickId } = await ui.sendPick();
		ui.controller.handleReply({ pickId, status, message: "" });
		await frames(2);
		const nextFrame = vi.spyOn(window, "requestAnimationFrame");

		await frames(3);

		expect(nextFrame).not.toHaveBeenCalled();
		nextFrame.mockRestore();
	},
);

/** a done marker, and its element moved somewhere else on the page */
async function settledAndMoved() {
	const ui = mount();
	const { pickId, element } = await ui.sendPick();
	ui.controller.handleReply({
		pickId,
		status: "done",
		message: "made it bold",
	});
	await frames(2);
	const [marker] = ui.markers();
	if (!marker) throw new Error("no marker");
	const before = marker.style.transform;
	vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
		new DOMRect(40, 300, 10, 10),
	);
	return { ui, marker, before };
}

test.each([
	[
		"the page scrolls",
		() => {
			const scroller = document.createElement("div");
			scroller.className = "page";
			document.body.append(scroller);
			scroller.dispatchEvent(new Event("scroll"));
		},
	],
	["the window resizes", () => window.dispatchEvent(new Event("resize"))],
	[
		"the page repaints (hmr)",
		() => {
			const replaced = document.createElement("div");
			replaced.className = "page";
			document.body.append(replaced);
		},
	],
])("a done marker follows its element again when %s", async (_, change) => {
	const { marker, before } = await settledAndMoved();

	change();
	await frames(1);

	expect(marker.style.transform).not.toBe(before);
});

test("a placement pass measures every marker before moving any", async () => {
	const ui = mount();
	const a = await ui.sendPick("bold");
	const b = await ui.sendPick("red", { ...selection, component: "Header" });
	await frames(2);
	// where the markers stood at each measurement
	const spotsAtEachRead: string[] = [];
	for (const element of [a.element, b.element])
		vi.spyOn(element, "getBoundingClientRect").mockImplementation(() => {
			spotsAtEachRead.push(
				ui
					.markers()
					.map((marker) => marker.style.transform)
					.join(" "),
			);
			// a new spot every read, so the pass moves both markers
			return new DOMRect(0, spotsAtEachRead.length * 10, 10, 10);
		});

	window.dispatchEvent(new Event("resize"));
	await frames(1);

	const [first, second] = spotsAtEachRead;
	expect(second).toBe(first);
	expect(
		ui
			.markers()
			.map((marker) => marker.style.transform)
			.join(" "),
	).not.toBe(second);
});

/** the content element radix's Dialog renders (no aria-modal), or an aria-modal one */
function openModal(attributes: Record<string, string>): HTMLElement {
	const modal = document.createElement("div");
	modal.className = "modal";
	for (const [name, value] of Object.entries(attributes))
		modal.setAttribute(name, value);
	document.body.append(modal);
	return modal;
}

const MODALS = [
	["radix Dialog", { role: "dialog", "data-state": "open" }],
	["aria-modal dialog", { role: "dialog", "aria-modal": "true" }],
] as const;

test.each(MODALS)(
	"picking inside an open %s puts the box inside it, so its focus trap and outside-click keep out of the way",
	(_, attributes) => {
		const ui = mount();
		const modal = openModal(attributes);
		popoverCalls.length = 0;

		ui.pick(selection, modal);

		expect(ui.host.parentElement).toBe(modal);
		expect(popoverCalls).toEqual([false, true]);
		expect(ui.root.activeElement).toBe(ui.note);
	},
);

test("closing the box moves the overlay back out of the dialog", () => {
	const ui = mount();
	const modal = openModal({ role: "dialog", "data-state": "open" });
	ui.pick(selection, modal);

	ui.key({ key: "Escape" });

	expect(ui.host.parentElement).toBe(document.documentElement);
	expect(popoverCalls.at(-1)).toBe(true);
});

test.each([
	[
		"closes",
		(modal: HTMLElement) => modal.setAttribute("data-state", "closed"),
	],
	["unmounts, overlay and all", (modal: HTMLElement) => modal.remove()],
])(
	"the dialog that %s under an open box gives the overlay back to the page",
	async (_, dismiss) => {
		const ui = mount();
		const modal = openModal({ role: "dialog", "data-state": "open" });
		ui.pick(selection, modal);

		dismiss(modal);
		await frames(2);

		expect(ui.host.parentElement).toBe(document.documentElement);
		expect(ui.composer.hidden).toBe(false);
	},
);

test("a pick outside any dialog leaves the overlay on the page", () => {
	const ui = mount();
	openModal({ role: "dialog", "data-state": "open" });

	ui.pick();

	expect(ui.host.parentElement).toBe(document.documentElement);
});

test("while react-grab is picking, markers let the pointer through to the page except their dismiss button", async () => {
	const ui = mount();
	await ui.sendPick();
	const [marker] = ui.markers();
	const dismiss = marker?.querySelector("button");
	if (!marker || !dismiss) throw new Error("no marker");

	ui.overlay.grabbing(true);
	expect(getComputedStyle(marker).pointerEvents).toBe("none");
	expect(getComputedStyle(dismiss).pointerEvents).toBe("auto");

	ui.overlay.grabbing(false);
	expect(getComputedStyle(marker).pointerEvents).toBe("auto");
});

test("a done marker whose text changes is placed again for its new size", async () => {
	const ui = mount();
	const { pickId, element } = await ui.sendPick();
	ui.controller.handleReply({
		pickId,
		status: "done",
		message: "made it bold",
	});
	await frames(2);
	const measure = vi.spyOn(element, "getBoundingClientRect");

	ui.controller.handleReply({
		pickId,
		status: "question",
		message: "which price?",
	});
	await frames(2);

	expect(measure).toHaveBeenCalled();
});

test("a reply landing after the box's dialog unmounted, before the next frame, puts the overlay back on the page", () => {
	const ui = mount();
	const modal = openModal({ role: "dialog", "data-state": "open" });
	ui.pick(selection, modal);
	modal.remove();

	ui.controller.handleStatus({ status: "connected" });

	expect(ui.host.parentElement).toBe(document.documentElement);
});

test("the overlay is never a layout item in the dialog it moves into", () => {
	const ui = mount();

	expect(ui.host.style.getPropertyValue("display")).toBe("contents");
	expect(ui.host.style.getPropertyPriority("display")).toBe("important");
});

test("when the inner of two dialogs closes, the box moves to the outer one and keeps focus", async () => {
	const ui = mount();
	const outer = openModal({ role: "dialog", "aria-modal": "true" });
	const inner = document.createElement("div");
	inner.setAttribute("role", "dialog");
	inner.setAttribute("data-state", "open");
	outer.append(inner);
	ui.pick(selection, inner);

	inner.setAttribute("data-state", "closed");
	await frames(2);

	expect(ui.host.parentElement).toBe(outer);
	expect(ui.root.activeElement).toBe(ui.note);
});

test("a pick made with focus on a marker's dismiss button gives focus back to it", async () => {
	const ui = mount();
	await ui.sendPick();
	const dismiss = ui.markers()[0]?.querySelector("button");
	dismiss?.focus();

	ui.pick();
	ui.key({ key: "Escape" });

	expect(ui.root.activeElement).toBe(dismiss);
});

// happy-dom focuses any element; a browser won't focus a div without a tabindex
function unfocusable(element: Element): void {
	Object.assign(element, { focus: () => {} });
}

test("when focus can't go back where it was, it goes to the picked element", () => {
	const ui = mount();
	const before = focusedPageButton();
	const element = ui.pick();
	element.tabIndex = 0;
	before.disabled = true;

	ui.key({ key: "Escape" });

	expect(document.activeElement).toBe(element);
});

test("when neither the old focus nor the picked element can take it, the dialog does", () => {
	const ui = mount();
	const modal = openModal({ role: "dialog", "data-state": "open" });
	modal.tabIndex = -1;
	const before = focusedPageButton();
	unfocusable(ui.pick(selection, modal));
	before.disabled = true;

	ui.key({ key: "Escape" });

	expect(document.activeElement).toBe(modal);
});

test("dismissing the marker of an element that's gone forgets the pick", async () => {
	const ui = mount();
	const { pickId, element } = await ui.sendPick();
	element.remove();
	ui.markers()[0]?.querySelector<HTMLButtonElement>(".dismiss")?.click();

	ui.controller.handleReply({ pickId, status: "done", message: "done" });

	expect(ui.markers()).toHaveLength(0);
});
