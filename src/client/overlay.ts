import { domToPng } from "modern-screenshot";
import { NOT_CONNECTED, type PickController } from "./controller.ts";
import type { OnPick } from "./grab.ts";
import { buildPick, newPickId, type Selection } from "./payload.ts";
import { css } from "./styles.ts";

const GAP = 8;
const SCREENSHOT_TIMEOUT_MS = 5000;
const NO_SOURCE =
	"react-grab found no source file for this element. Try picking its parent component.";

interface Draft {
	element: Element;
	selection: Selection | undefined;
	screenshot: Promise<string | undefined>;
	sending: boolean;
	error?: string | undefined;
}

interface Marker {
	root: HTMLElement;
	badge: HTMLElement;
	bubble: HTMLElement;
	anchor: Anchor;
}

/** follows its element; after an hmr repaint replaces the node, stays where it last was */
class Anchor {
	#element: Element;
	#last: DOMRect;

	constructor(element: Element) {
		this.#element = element;
		this.#last = element.getBoundingClientRect();
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
export function mountOverlay(controller: PickController): OnPick {
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
	const target = el("p", { class: "target" });
	const note = el("textarea", { id: "note", rows: "3" });
	const notice = el("p", { class: "notice", role: "status" });
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
	document.documentElement.append(host);
	layer.showPopover();

	const markers = new Map<string, Marker>();
	const anchors = new Map<string, Anchor>();
	let draft: Draft | undefined;
	let draftAnchor: Anchor | undefined;

	function renderComposer(): void {
		send.disabled =
			!draft || draft.sending || !draft.selection || !controller.canSend;
		notice.textContent =
			(draft && !draft.selection ? NO_SOURCE : undefined) ??
			controller.notice ??
			draft?.error ??
			"";
	}

	function renderPicks(): void {
		for (const [pickId, marker] of markers) {
			if (controller.picks.has(pickId)) continue;
			marker.root.remove();
			markers.delete(pickId);
		}
		for (const [pickId, state] of controller.picks) {
			const anchor = anchors.get(pickId);
			if (!anchor) continue;
			const marker = markers.get(pickId) ?? addMarker(pickId, anchor);
			marker.badge.textContent = state.badge;
			marker.badge.dataset.badge = state.badge;
			marker.bubble.textContent = state.message ?? "";
		}
		follow();
	}

	function addMarker(pickId: string, anchor: Anchor): Marker {
		const badge = el("span", { class: "badge" });
		const dismiss = el(
			"button",
			{ type: "button", class: "dismiss", "aria-label": "Dismiss" },
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
			anchors.delete(pickId);
		});
		layer.append(markerRoot);
		const marker = { root: markerRoot, badge, bubble, anchor };
		markers.set(pickId, marker);
		return marker;
	}

	let frame = 0;
	function follow(): void {
		if (frame) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			if (draftAnchor) place(composer, draftAnchor.rect());
			for (const marker of markers.values())
				place(marker.root, marker.anchor.rect());
			if (draftAnchor || markers.size > 0) follow();
		});
	}

	function close(): void {
		draft = undefined;
		draftAnchor = undefined;
		composer.hidden = true;
	}

	async function submit(): Promise<void> {
		const current = draft;
		if (!current?.selection || send.disabled) return;
		current.sending = true;
		current.error = undefined;
		renderComposer();
		const pickId = newPickId();
		anchors.set(pickId, new Anchor(current.element));
		const outcome = await controller.send(
			buildPick({
				pickId,
				note: note.value,
				selection: current.selection,
				screenshot: await current.screenshot,
			}),
		);
		current.sending = false;
		if (!outcome.ok) {
			anchors.delete(pickId);
			// a 503 shows through the controller's notice, which clears when claude connects
			if (outcome.error !== NOT_CONNECTED) current.error = outcome.error;
		}
		// the user may have picked another element while this one was sending
		if (draft !== current) return;
		if (outcome.ok) close();
		else renderComposer();
	}

	composer.addEventListener("submit", (event) => {
		event.preventDefault();
		void submit();
	});
	composer.addEventListener("keydown", (event) => {
		// the app's own shortcuts shouldn't fire while typing a note
		event.stopPropagation();
		if (event.key === "Escape") close();
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
			composer.requestSubmit();
	});
	cancel.addEventListener("click", close);
	controller.subscribe(() => {
		renderComposer();
		renderPicks();
	});

	return (element, selection) => {
		draft = {
			element,
			selection,
			// a failed screenshot sends the pick without one
			screenshot: selection
				? domToPng(element, { timeout: SCREENSHOT_TIMEOUT_MS }).catch(
						() => undefined,
					)
				: Promise.resolve(undefined),
			sending: false,
		};
		draftAnchor = new Anchor(element);
		target.textContent = selection
			? `${selection.component} · ${location(selection)}`
			: element.localName;
		note.value = "";
		composer.hidden = false;
		renderComposer();
		place(composer, draftAnchor.rect());
		follow();
		note.focus();
	};
}

function location({ file, line, column }: Selection): string {
	return [file, line, column].filter((part) => part !== undefined).join(":");
}

/** below the element, or above it when there's no room below, kept on screen */
function place(panel: HTMLElement, rect: DOMRect): void {
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
	panel.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
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
