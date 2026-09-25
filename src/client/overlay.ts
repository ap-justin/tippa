import { domToPng } from "modern-screenshot";
import {
	NOT_CONNECTED,
	type PickController,
	type PickState,
} from "./controller.ts";
import type { PickTarget } from "./grab.ts";
import { buildPick, newPickId, type Selection } from "./payload.ts";
import { css } from "./styles.ts";

const GAP = 8;
/** the whole capture; past it the pick sends without a screenshot */
const SCREENSHOT_DEADLINE_MS = 5000;
/** modern-screenshot's, per image load and per fetch; under the deadline, so a hung asset is skipped, not the shot */
const ASSET_TIMEOUT_MS = 2000;
// per side; a larger canvas is scaled down to fit. mdn: desktop browsers draw at least 10k x 10k,
// and past a browser's limit the canvas is empty
const MAX_CANVAS_SIDE = 10_000;
// radix's Dialog content sets no aria-modal; its role and open state mark it
const MODAL =
	'dialog:modal, [aria-modal="true"], [role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';
const RACED_CONNECT = "Couldn't reach Claude — send again";
const NO_SOURCE =
	"react-grab found no source file for this element. Try picking its parent component.";

interface Draft {
	element: Element;
	selection: Selection | undefined;
	screenshot: Promise<string | undefined>;
	sending: boolean;
	/** closed by the user; a send still waiting on its screenshot posts nothing */
	cancelled: boolean;
	error?: string | undefined;
}

interface Sent {
	anchor: Anchor;
	/** the picked component, naming the marker's dismiss button */
	name: string;
}

interface Marker {
	root: HTMLElement;
	badge: HTMLElement;
	bubble: HTMLElement;
	anchor: Anchor;
	/** a send that failed after the user moved on; the controller no longer has it */
	failed: boolean;
	/** placed for the last time: done, failed, or its element is gone */
	settled: boolean;
}

/** follows its element; after an hmr repaint replaces the node, stays where it last was */
class Anchor {
	#element: Element;
	#last: DOMRect;

	constructor(element: Element) {
		this.#element = element;
		this.#last = element.getBoundingClientRect();
	}

	get connected(): boolean {
		return this.#element.isConnected;
	}

	rect(): DOMRect {
		if (this.#element.isConnected)
			this.#last = this.#element.getBoundingClientRect();
		return this.#last;
	}
}

/**
 * the note box and per-pick badges and bubbles, in a shadow root in the top layer:
 * the app's css can't reach in, and react-grab skips the host when hit-testing.
 */
export function mountOverlay(controller: PickController): PickTarget {
	const sheet = new CSSStyleSheet();
	sheet.replaceSync(css);
	const host = document.createElement("ui-pick-overlay");
	host.setAttribute("data-react-grab-ignore", "");
	host.setAttribute("data-react-grab-ignore-events", "");
	const root = host.attachShadow({ mode: "open" });
	root.adoptedStyleSheets = [sheet];

	const layer = el("div", { class: "layer", popover: "manual" });
	const composer = el("form", { class: "panel composer", hidden: "" });
	const label = el("label", { for: "note" }, "Note for Claude");
	const target = el("p", { class: "target", id: "target" });
	const note = el("textarea", {
		id: "note",
		rows: "3",
		"aria-describedby": "target notice",
	});
	// in the tree while empty: a live region that appears already holding text goes unannounced
	const notice = el("p", { class: "notice", id: "notice", role: "status" });
	const cancel = el("button", { type: "button" }, "Cancel");
	const send = el("button", { type: "submit" }, "Send to Claude");
	composer.append(
		label,
		target,
		note,
		notice,
		el("div", { class: "actions" }, cancel, send),
	);
	layer.append(composer);
	root.append(layer);
	// the dialog the open box's pick sits in; the host lives in it while the box is open
	let modal: Element | undefined;
	attach();

	/**
	 * in the page, inside the dialog the open box's pick sits in, and last in the top layer
	 * so app ui opened since paints below it. inside the dialog, its focus trap and
	 * outside-click checks count the box as its own, and a native modal leaves it uninert.
	 */
	function attach(): void {
		const parent = modal ?? document.documentElement;
		// a moved popover is hidden on removal, so every move re-shows it
		if (host.parentNode !== parent) parent.append(host);
		layer.togglePopover(false);
		layer.togglePopover(true);
	}

	function isOpenModal(container: Element): boolean {
		return container.isConnected && container.matches(MODAL);
	}

	const markers = new Map<string, Marker>();
	const sent = new Map<string, Sent>();
	// the state each dismissed marker last showed; the next reply to its pick brings it back
	const dismissed = new Map<string, PickState>();
	let draft: Draft | undefined;
	let draftAnchor: Anchor | undefined;
	// focus before the box opened, given back when it closes
	let returnFocus: HTMLElement | SVGElement | undefined;

	function renderComposer(): void {
		const disabled =
			!draft || draft.sending || !draft.selection || !controller.canSend;
		// a disabled button drops focus to <body>, where Escape and Cmd+Enter no longer reach the box
		if (disabled && root.activeElement === send) note.focus();
		send.disabled = disabled;
		setText(
			notice,
			(draft && !draft.selection ? NO_SOURCE : undefined) ??
				controller.notice ??
				draft?.error ??
				"",
		);
	}

	function renderPicks(): void {
		if (!host.isConnected) attach();
		for (const [pickId, marker] of markers) {
			if (controller.picks.has(pickId) || marker.failed) continue;
			marker.root.remove();
			markers.delete(pickId);
		}
		for (const [pickId, state] of controller.picks) {
			const pick = sent.get(pickId);
			if (!pick || dismissed.get(pickId) === state) continue;
			dismissed.delete(pickId);
			const marker = markers.get(pickId) ?? addMarker(pickId, pick);
			// unchanged text is left alone: a rewrite re-announces the marker's status region
			const badgeChanged = setText(marker.badge, state.badge);
			if (badgeChanged) marker.badge.dataset.badge = state.badge;
			// new text resizes the panel, so it's placed again
			if (setText(marker.bubble, state.message ?? "") || badgeChanged)
				marker.settled = false;
		}
		follow();
	}

	function addMarker(pickId: string, { anchor, name }: Sent): Marker {
		const badge = el("span", { class: "badge" });
		const dismiss = el(
			"button",
			{
				type: "button",
				class: "dismiss",
				"aria-label": `Dismiss reply for ${name}`,
			},
			"×",
		);
		const bubble = el("p", { class: "bubble" });
		const markerRoot = el(
			"div",
			{ class: "panel pick", role: "status" },
			el("div", { class: "pick-head" }, badge, dismiss),
			bubble,
		);
		dismiss.addEventListener("click", () => {
			markerRoot.remove();
			markers.delete(pickId);
			const state = controller.picks.get(pickId);
			if (state) dismissed.set(pickId, state);
		});
		layer.append(markerRoot);
		const marker = {
			root: markerRoot,
			badge,
			bubble,
			anchor,
			failed: false,
			settled: false,
		};
		markers.set(pickId, marker);
		return marker;
	}

	/** a marker the controller doesn't track: gone when dismissed */
	function showFailure(pickId: string, pick: Sent, message: string): void {
		const marker = addMarker(pickId, pick);
		marker.failed = true;
		marker.badge.textContent = "not sent";
		marker.badge.dataset.badge = "failed";
		marker.bubble.textContent = message;
		follow();
	}

	let frame = 0;
	/** per frame while the box is open or a marker's pick is still moving */
	function follow(): void {
		if (frame) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			if (modal && !isOpenModal(modal)) {
				modal = undefined;
				attach();
			}
			// removed from the page: nothing to place until a pick or reply attaches it again
			if (!host.isConnected) return;
			const moving = [...markers.values()].filter((marker) => !marker.settled);
			const panels: [HTMLElement, Anchor][] = moving.map((marker) => [
				marker.root,
				marker.anchor,
			]);
			if (draftAnchor) panels.push([composer, draftAnchor]);
			// every read before any write: interleaved, each panel forces its own layout
			const spots = panels.map(([panel, anchor]) =>
				spotFor(panel, anchor.rect()),
			);
			panels.forEach(([panel], index) => {
				panel.style.transform = spots[index] ?? "";
			});
			// placed where it ends up; its pick won't move again
			for (const marker of moving)
				marker.settled =
					marker.failed ||
					marker.badge.dataset.badge === "done" ||
					!marker.anchor.connected;
			if (draftAnchor || moving.some((marker) => !marker.settled)) follow();
		});
	}

	function close(): void {
		if (draft) draft.cancelled = true;
		draft = undefined;
		draftAnchor = undefined;
		// not when the user already moved on into the page while a send was out
		if (composer.contains(root.activeElement) && returnFocus?.isConnected)
			returnFocus.focus({ preventScroll: true });
		composer.hidden = true;
		if (modal) {
			modal = undefined;
			attach();
		}
	}

	async function submit(): Promise<void> {
		const current = draft;
		if (!current?.selection || send.disabled) return;
		current.sending = true;
		current.error = undefined;
		renderComposer();
		const text = note.value;
		const screenshot = await current.screenshot;
		if (current.cancelled) return;
		const pickId = newPickId();
		const pick: Sent = {
			anchor: new Anchor(current.element),
			name: current.selection.component,
		};
		sent.set(pickId, pick);
		const outcome = await controller.send(
			buildPick({
				pickId,
				note: text,
				selection: current.selection,
				screenshot,
			}),
		);
		current.sending = false;
		if (!outcome.ok) {
			sent.delete(pickId);
			// a 503 shows through the controller's notice, which clears when claude connects
			if (outcome.error !== NOT_CONNECTED) current.error = outcome.error;
			// claude connected while this one was in flight
			else if (controller.canSend) current.error = RACED_CONNECT;
		}
		if (outcome.ok) {
			if (draft === current) close();
		} else if (draft === current) renderComposer();
		else if (current.cancelled) return;
		// picked something else while this one was sending: a note typed there stays,
		// and this one's failure and note go on its marker
		else if (draft && !draft.sending && note.value.trim())
			showFailure(pickId, pick, `${outcome.error}\n${text}`);
		// otherwise it comes back as the draft so its note isn't lost
		else open(current, text);
	}

	composer.addEventListener("submit", (event) => {
		event.preventDefault();
		void submit();
	});
	// the app's bubble-phase key listeners don't see typing in the note;
	// its capture-phase ones still do, with the host as target
	for (const type of ["keyup", "keypress"])
		composer.addEventListener(type, (event) => event.stopPropagation());
	composer.addEventListener("keydown", (event) => {
		event.stopPropagation();
		// Escape and Enter belong to the IME while it's converting
		if (event.isComposing) return;
		if (event.key === "Escape") close();
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
			composer.requestSubmit();
	});
	cancel.addEventListener("click", close);
	controller.subscribe(() => {
		renderComposer();
		renderPicks();
	});

	function open(next: Draft, text: string): void {
		// focus on the host means the box is already open; keep what it opened over
		const active = document.activeElement;
		if (active !== host)
			returnFocus =
				active !== document.body &&
				(active instanceof HTMLElement || active instanceof SVGElement)
					? active
					: undefined;
		draft = next;
		draftAnchor = new Anchor(next.element);
		modal = next.element.closest(MODAL) ?? undefined;
		// before focusing: moving the host blurs whatever is focused inside it
		attach();
		target.textContent = next.selection
			? `${next.selection.component} · ${location(next.selection)}`
			: next.element.localName;
		note.value = text;
		composer.hidden = false;
		renderComposer();
		composer.style.transform = spotFor(composer, draftAnchor.rect());
		follow();
		note.focus();
	}

	function pick(element: Element, selection: Selection | undefined): void {
		// an unsent note carries over to the new pick; one already sending went with its pick
		const text = draft && !draft.sending ? note.value : "";
		open(
			{
				element,
				selection,
				screenshot: selection ? capture(element) : Promise.resolve(undefined),
				sending: false,
				cancelled: false,
			},
			text,
		);
	}

	return {
		pick,
		grabbing(active) {
			layer.toggleAttribute("data-grabbing", active);
		},
	};
}

/** a png data url, or undefined when the capture fails or runs past its deadline */
function capture(element: Element): Promise<string | undefined> {
	const deadline = new Promise<undefined>((resolve) =>
		setTimeout(resolve, SCREENSHOT_DEADLINE_MS),
	);
	const shot = domToPng(element, {
		timeout: ASSET_TIMEOUT_MS,
		maximumCanvasSize: MAX_CANVAS_SIDE,
	}).catch(() => undefined);
	return Promise.race([shot, deadline]);
}

function location({ file, line, column }: Selection): string {
	return [file, line, column].filter((part) => part !== undefined).join(":");
}

/** the transform putting `panel` below the element, or above it when there's no room below, on screen */
function spotFor(panel: HTMLElement, rect: DOMRect): string {
	const { offsetWidth: width, offsetHeight: height } = panel;
	const below = rect.bottom + GAP;
	const top =
		below + height <= innerHeight
			? below
			: Math.max(GAP, rect.top - GAP - height);
	const left = Math.min(
		Math.max(GAP, rect.left),
		Math.max(GAP, innerWidth - width - GAP),
	);
	return `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

/** true when the text changed */
function setText(node: HTMLElement, text: string): boolean {
	if (node.textContent === text) return false;
	node.textContent = text;
	return true;
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attributes: Record<string, string>,
	...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	for (const [name, value] of Object.entries(attributes))
		element.setAttribute(name, value);
	element.append(...children);
	return element;
}
