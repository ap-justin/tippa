import { domToPng } from "modern-screenshot";
import { MAX_PICK_ELEMENTS, MAX_SCREENSHOT_CHARS } from "../protocol.ts";
import { NOT_CONNECTED, type PickController } from "./controller.ts";
import type { PickTarget } from "./grab.ts";
import { base64Of, buildPick, newPickId, type Selection } from "./payload.ts";
import { css } from "./styles.ts";

const GAP = 8;
/** px an arrow key moves the note box; with Shift, BIG_STEP */
const STEP = 10;
const BIG_STEP = 50;
const ARROWS: Partial<Record<string, [number, number]>> = {
	ArrowLeft: [-1, 0],
	ArrowRight: [1, 0],
	ArrowUp: [0, -1],
	ArrowDown: [0, 1],
};
/** the whole capture; past it the pick sends without a screenshot */
const SCREENSHOT_DEADLINE_MS = 5000;
/** modern-screenshot's, per image load and per fetch; under the deadline, so a hung asset is skipped, not the shot */
const ASSET_TIMEOUT_MS = 2000;
// per side; a larger canvas is scaled down to fit. mdn: desktop browsers draw at least 10k x 10k,
// and past a browser's limit the canvas is empty
const MAX_CANVAS_SIDE = 10_000;
// under the scale that would just fit: compression varies with the content
const RETRY_MARGIN = 0.9;
// radix's Dialog content sets no aria-modal; its role and open state mark it
const MODAL =
	'dialog:modal, [aria-modal="true"], [role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';
/** how long a sent note's Sent tags stay, their fade included; styles.ts fades them over the same time */
const SENT_MS = 2000;
const RACED_CONNECT = "Couldn't reach Claude. Send again.";
const TOO_MANY = `Up to ${MAX_PICK_ELEMENTS} elements per note.`;
const NO_SOURCE =
	"react-grab found no source file for this element. Try picking its parent component.";

/** one element of a draft; the note refers to `elements[i]` as `[i + 1]` */
interface Picked {
	anchor: Anchor;
	/** undefined only for a draft's sole element, which then can't be sent */
	selection: Selection | undefined;
	screenshot: Promise<string | undefined>;
}

interface Draft {
	elements: Picked[];
	sending: boolean;
	/** closed by the user; a send still waiting on its screenshot posts nothing */
	cancelled: boolean;
	error?: string | undefined;
}

/** an element's number in the open note, or Sent once its note posted */
interface Tag {
	root: HTMLElement;
	anchor: Anchor;
}

/** a send that failed after the user moved on to another note: its error and note, until dismissed */
interface Marker {
	root: HTMLElement;
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

	get element(): Element {
		return this.#element;
	}

	rect(): DOMRect {
		if (this.#element.isConnected)
			this.#last = this.#element.getBoundingClientRect();
		return this.#last;
	}
}

/**
 * the note box, element tags and failed-send markers, in a shadow root in the top layer:
 * the app's css can't reach in, and react-grab skips the host when hit-testing.
 */
export function mountOverlay(controller: PickController): PickTarget {
	const sheet = new CSSStyleSheet();
	sheet.replaceSync(css);
	const host = document.createElement("tippa-overlay");
	host.setAttribute("data-react-grab-ignore", "");
	host.setAttribute("data-react-grab-ignore-events", "");
	// never a grid or flex item in the dialog it moves into; inline and important beat the page's rules
	host.style.setProperty("display", "contents", "important");
	const root = host.attachShadow({ mode: "open" });
	root.adoptedStyleSheets = [sheet];

	const layer = el("div", { class: "layer", popover: "manual" });
	const composer = el("form", { class: "panel composer", hidden: "" });
	// pointer and arrow keys move the box; its label still names the note
	const handle = el(
		"div",
		{
			class: "handle",
			tabindex: "0",
			role: "button",
			"aria-label": "Move note box",
		},
		el("label", { for: "note" }, "Note for Claude"),
	);
	const target = el("p", { class: "target", id: "target" });
	const note = el("textarea", {
		id: "note",
		rows: "3",
		"aria-describedby": "target notice",
	});
	// in the tree while empty: a live region that appears already holding text goes unannounced
	const notice = el("p", { class: "notice", id: "notice", role: "status" });
	const list = el("ol", { class: "elements", "aria-label": "Elements" });
	const cancel = el("button", { type: "button" }, "Cancel");
	const send = el("button", { type: "submit" }, "Send to Claude");
	composer.append(
		handle,
		target,
		note,
		notice,
		list,
		el("div", { class: "actions" }, cancel, send),
	);
	// outside the composer, which hides as a note sends; in the tree while empty, like the notice
	const announce = el("p", { class: "announce", role: "status" });
	layer.append(composer, announce);
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
		// a closed or unmounted dialog, possibly with the host inside, before a frame noticed
		if (modal && !isOpenModal(modal)) modal = enclosingModal();
		const parent = modal ?? document.documentElement;
		const moving = host.parentNode !== parent;
		// moving blurs the note; removed with its dialog, it already lost focus to <body>
		const active = document.activeElement;
		const typing =
			moving &&
			!composer.hidden &&
			(host.isConnected
				? root.activeElement === note
				: !active || active === document.body);
		if (moving) parent.append(host);
		// a moved popover is hidden on removal, so every move re-shows it
		layer.togglePopover(false);
		layer.togglePopover(true);
		if (typing) note.focus();
	}

	/** the next open dialog out from the box's pick, or from the dialog that just closed */
	function enclosingModal(): Element | undefined {
		for (const from of [draftAnchor?.element, modal?.parentElement]) {
			const found = from?.closest(MODAL);
			if (found && isOpenModal(found)) return found;
		}
		return undefined;
	}

	function isOpenModal(container: Element): boolean {
		return container.isConnected && container.matches(MODAL);
	}

	const markers = new Map<string, Marker>();
	const tags = new Map<string, Tag>();
	// each sent note's elements, tagged Sent until its fade ends
	const sent = new Map<string, Anchor[]>();
	let draft: Draft | undefined;
	let draftAnchor: Anchor | undefined;
	// focus before the box opened, given back when it closes
	let returnFocus: HTMLElement | SVGElement | undefined;
	// where the user moved this note's box; it stays there until the note closes
	let moved: Point | undefined;

	function renderComposer(): void {
		const disabled =
			!draft ||
			draft.sending ||
			!draft.elements[0]?.selection ||
			!controller.canSend;
		const sending = draft?.sending ?? false;
		// a disabled button drops focus to <body>, where Escape and Cmd+Enter no longer reach the box
		if (
			(disabled && root.activeElement === send) ||
			(sending && list.contains(root.activeElement))
		)
			note.focus();
		send.disabled = disabled;
		for (const remove of list.querySelectorAll("button"))
			remove.disabled = sending;
		setText(
			notice,
			(draft && !draft.elements[0]?.selection ? NO_SOURCE : undefined) ??
				controller.notice ??
				draft?.error ??
				"",
		);
	}

	/** a marker for a note whose send failed after the user moved on: gone when dismissed */
	function showFailure(
		pickId: string,
		anchor: Anchor,
		name: string,
		message: string,
	): void {
		const dismiss = el(
			"button",
			{
				type: "button",
				class: "dismiss",
				"aria-label": `Dismiss unsent note for ${name}`,
			},
			"×",
		);
		const markerRoot = el(
			"div",
			{ class: "panel pick", role: "status" },
			el(
				"div",
				{ class: "pick-head" },
				el("span", { class: "badge" }, "not sent"),
				dismiss,
			),
			el("p", { class: "bubble" }, message),
		);
		dismiss.addEventListener("click", () => {
			markerRoot.remove();
			markers.delete(pickId);
		});
		layer.append(markerRoot);
		markers.set(pickId, { root: markerRoot, anchor });
		schedule();
	}

	/** tags a sent note's elements Sent, and clears them once they've faded */
	function showSent(pickId: string, anchors: Anchor[]): void {
		if (!host.isConnected) attach();
		sent.set(pickId, anchors);
		setText(announce, "Sent to Claude");
		renderTags();
		setTimeout(() => {
			sent.delete(pickId);
			if (sent.size === 0) setText(announce, "");
			renderTags();
		}, SENT_MS);
	}

	let frame = 0;
	/**
	 * one placement pass next frame. passes run every frame while the box is open, and
	 * otherwise when the page scrolls, resizes or changes (an hmr repaint shifts layout)
	 */
	function schedule(): void {
		if (frame) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			if (modal && !isOpenModal(modal)) attach();
			// removed from the page: nothing to place until a pick attaches it again
			if (!host.isConnected) return;
			placeAll();
			if (draftAnchor) schedule();
		});
	}

	function placeAll(): void {
		type Placed = [HTMLElement, Anchor, typeof spotFor];
		const panels = [
			...[...markers.values()].map(
				(marker): Placed => [marker.root, marker.anchor, spotFor],
			),
			...[...tags.values()].map(
				(tag): Placed => [tag.root, tag.anchor, tagSpot],
			),
		];
		if (draftAnchor) panels.push([composer, draftAnchor, composerSpot]);
		// every read before any write: interleaved, each panel forces its own layout
		const spots = panels.map(([panel, anchor, spot]) =>
			spot(panel, anchor.rect()),
		);
		panels.forEach(([panel], index) => {
			const spot = spots[index];
			panel.style.transform = spot ? translate(spot) : "";
		});
	}

	function composerSpot(panel: HTMLElement, rect: DOMRect): Point {
		return moved ? inView(panel, moved) : spotFor(panel, rect);
	}

	function moveBox(to: Point): void {
		moved = inView(composer, to);
		composer.style.transform = translate(moved);
	}

	let drag:
		| { pointerId: number; x: number; y: number; from: Point }
		| undefined;
	// the app's bubble-phase listeners don't see a drag; react-grab's skip the host
	for (const type of ["pointerdown", "pointermove", "pointerup", "click"])
		handle.addEventListener(type, (event) => event.stopPropagation());
	handle.addEventListener("pointerdown", (event) => {
		if (event.button !== 0 || !event.isPrimary || !draftAnchor) return;
		// no text selection, and focus stays in the note
		event.preventDefault();
		handle.setPointerCapture(event.pointerId);
		drag = {
			pointerId: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			from: composerSpot(composer, draftAnchor.rect()),
		};
	});
	handle.addEventListener("pointermove", (event) => {
		if (event.pointerId !== drag?.pointerId) return;
		moveBox({
			left: drag.from.left + event.clientX - drag.x,
			top: drag.from.top + event.clientY - drag.y,
		});
	});
	for (const type of ["pointerup", "pointercancel"])
		handle.addEventListener(type, () => {
			drag = undefined;
		});
	handle.addEventListener("keydown", (event) => {
		const [dx, dy] = ARROWS[event.key] ?? [];
		if (dx === undefined || dy === undefined || !draftAnchor) return;
		event.preventDefault();
		const step = event.shiftKey ? BIG_STEP : STEP;
		const from = composerSpot(composer, draftAnchor.rect());
		moveBox({ left: from.left + dx * step, top: from.top + dy * step });
	});

	function pageMoved(): void {
		if (markers.size > 0 || tags.size > 0 || draftAnchor) schedule();
	}
	document.addEventListener("scroll", pageMoved, {
		capture: true,
		passive: true,
	});
	window.addEventListener("resize", pageMoved);
	// changes inside the shadow root, the overlay's own placement included, aren't seen here
	new MutationObserver(pageMoved).observe(document.documentElement, {
		subtree: true,
		childList: true,
		attributes: true,
		characterData: true,
	});

	function close(): void {
		const picked = draftAnchor?.element;
		if (draft) draft.cancelled = true;
		draft = undefined;
		draftAnchor = undefined;
		moved = undefined;
		drag = undefined;
		// not when the user already moved on into the page while a send was out
		if (composer.contains(root.activeElement))
			giveFocusBack(returnFocus, picked);
		returnFocus = undefined;
		composer.hidden = true;
		renderTags();
		if (modal) {
			modal = undefined;
			attach();
		}
	}

	async function submit(): Promise<void> {
		const current = draft;
		if (!current || send.disabled) return;
		current.sending = true;
		current.error = undefined;
		renderComposer();
		const text = note.value;
		const elements = await Promise.all(
			current.elements.map(async ({ selection, screenshot }) =>
				selection ? { selection, screenshot: await screenshot } : undefined,
			),
		);
		if (current.cancelled) return;
		const [first] = current.elements;
		const sendable = elements.filter((element) => element !== undefined);
		if (!first || sendable.length !== elements.length) return;
		const pickId = newPickId();
		const outcome = await controller.send(
			buildPick({ pickId, note: text, elements: sendable }),
		);
		current.sending = false;
		if (!outcome.ok) {
			// a 503 shows through the controller's notice, which clears when claude connects
			if (outcome.error !== NOT_CONNECTED) current.error = outcome.error;
			// claude connected while this one was in flight
			else if (controller.canSend) current.error = RACED_CONNECT;
		}
		if (outcome.ok) {
			if (draft === current) close();
			showSent(
				pickId,
				current.elements.map(({ anchor }) => anchor),
			);
		} else if (draft === current) renderComposer();
		else if (current.cancelled) return;
		// picked something else while this one was sending: a note typed there stays,
		// and this one's failure and note go on its marker
		else if (draft && !draft.sending && note.value.trim())
			showFailure(
				pickId,
				first.anchor,
				sendable[0]?.selection.component ?? "",
				`${outcome.error}\n${text}`,
			);
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
		// its dialog may have unmounted with it since the last frame
		if (!host.isConnected) attach();
		renderComposer();
	});

	function open(next: Draft, text: string): void {
		// a box already open with focus in it keeps what it first opened over
		if (composer.hidden || !composer.contains(root.activeElement)) {
			const active =
				document.activeElement === host
					? root.activeElement
					: document.activeElement;
			returnFocus =
				active !== document.body &&
				(active instanceof HTMLElement || active instanceof SVGElement)
					? active
					: undefined;
		}
		draft = next;
		moved = undefined;
		drag = undefined;
		const [first] = next.elements;
		draftAnchor = first?.anchor;
		modal = first?.anchor.element.closest(MODAL) ?? undefined;
		// before focusing: moving the host blurs whatever is focused inside it
		attach();
		target.textContent = first?.selection
			? `${first.selection.component} · ${location(first.selection)}`
			: (first?.anchor.element.localName ?? "");
		note.value = text;
		composer.hidden = false;
		renderList();
		renderComposer();
		if (draftAnchor)
			composer.style.transform = translate(
				spotFor(composer, draftAnchor.rect()),
			);
		schedule();
		note.focus();
	}

	function pick(element: Element, selection: Selection | undefined): void {
		// a draft whose sole element has no source is replaced instead
		if (draft && !draft.sending && draft.elements[0]?.selection) {
			add(draft, element, selection);
			return;
		}
		// an unsent note carries over to the new pick; one already sending went with its pick
		const text = draft && !draft.sending ? note.value : "";
		open(
			{
				elements: [newPicked(element, selection)],
				sending: false,
				cancelled: false,
			},
			text,
		);
	}

	function add(
		current: Draft,
		element: Element,
		selection: Selection | undefined,
	): void {
		const known = current.elements.findIndex(
			(picked) => picked.anchor.element === element,
		);
		if (known >= 0) {
			current.error = undefined;
			renderComposer();
			insertAtCursor(note, `[${known + 1}]`);
			note.focus();
			return;
		}
		if (current.elements.length >= MAX_PICK_ELEMENTS) {
			refuse(current, TOO_MANY);
			return;
		}
		if (!selection) {
			refuse(current, NO_SOURCE);
			return;
		}
		current.error = undefined;
		current.elements.push(newPicked(element, selection));
		// picked in a dialog opened since: its focus trap would pull focus out of a box left outside
		const dialog = modal ? undefined : element.closest(MODAL);
		if (dialog) {
			modal = dialog;
			attach();
		}
		renderComposer();
		insertAtCursor(note, `[${current.elements.length}]`);
		renderList();
		note.focus();
	}

	function refuse(current: Draft, reason: string): void {
		current.error = reason;
		renderComposer();
		note.focus();
	}

	function remove(current: Draft, index: number): void {
		current.elements.splice(index, 1);
		note.value = unmark(note.value, index + 1, current.elements.length + 1);
		renderList();
		// its button is gone with its row
		note.focus();
	}
	list.addEventListener("click", (event) => {
		const row = event.target instanceof Element && event.target.closest("li");
		if (!draft || !row || !event.target.closest(".remove")) return;
		remove(draft, [...list.children].indexOf(row));
	});

	function renderTags(): void {
		const wanted = new Map<
			string,
			{ anchor: Anchor; text: string; className: string }
		>();
		draft?.elements.forEach(({ anchor }, index) => {
			wanted.set(`draft ${index}`, {
				anchor,
				text: `[${index + 1}]`,
				className: "tag",
			});
		});
		for (const [pickId, anchors] of sent)
			anchors.forEach((anchor, index) => {
				wanted.set(`${pickId} ${index}`, {
					anchor,
					text: "Sent",
					className: "tag sent",
				});
			});
		for (const [key, tag] of tags) {
			if (wanted.has(key)) continue;
			tag.root.remove();
			tags.delete(key);
		}
		for (const [key, { anchor, text, className }] of wanted) {
			const known = tags.get(key);
			const tag = known ?? addTag(key, anchor, className);
			tag.anchor = anchor;
			setText(tag.root, text);
			// placed now, not next frame: a new tag would flash at the corner first
			if (!known)
				tag.root.style.transform = translate(tagSpot(tag.root, anchor.rect()));
		}
		schedule();
	}

	function addTag(key: string, anchor: Anchor, className: string): Tag {
		// the note's element list names them, and the announce region says a note sent;
		// on the page they're only a visual cue
		const tag = {
			root: el("span", { class: className, "aria-hidden": "true" }),
			anchor,
		};
		layer.append(tag.root);
		tags.set(key, tag);
		return tag;
	}

	function renderList(): void {
		list.replaceChildren(
			...(draft?.elements ?? []).map(({ selection, anchor }, index) =>
				el(
					"li",
					{},
					el(
						"span",
						{ class: "element-name" },
						rowName(index, selection, anchor),
					),
					...(index === 0
						? []
						: [
								el(
									"button",
									{
										type: "button",
										class: "remove",
										"aria-label": `Remove ${rowName(index, selection, anchor)}`,
									},
									"×",
								),
							]),
				),
			),
		);
		renderTags();
	}

	return {
		pick,
		grabbing(active) {
			layer.toggleAttribute("data-grabbing", active);
		},
	};
}

function newPicked(element: Element, selection: Selection | undefined): Picked {
	return {
		anchor: new Anchor(element),
		selection,
		screenshot: selection ? capture(element) : Promise.resolve(undefined),
	};
}

function rowName(
	index: number,
	selection: Selection | undefined,
	anchor: Anchor,
): string {
	return `[${index + 1}] ${selection?.component ?? anchor.element.localName}`;
}

/** `note` without marker `[removed]`, and each later marker up to `[count]` one lower */
function unmark(note: string, removed: number, count: number): string {
	const marker = `\\[${removed}\\]`;
	return note
		.replace(new RegExp(` ${marker}|${marker} ?`, "g"), "")
		.replace(/\[(\d)\]/g, (text, digit: string) => {
			const number = Number(digit);
			return number > removed && number <= count ? `[${number - 1}]` : text;
		});
}

/** `text` over the selection, with a space either side where a word would touch it; the cursor lands right after `text` */
function insertAtCursor(field: HTMLTextAreaElement, text: string): void {
	const { value, selectionStart: start, selectionEnd: end } = field;
	const before = start > 0 && /\S/.test(value[start - 1] ?? "") ? " " : "";
	const after = /[\p{L}\p{N}[]/u.test(value[end] ?? "") ? " " : "";
	field.setRangeText(`${before}${text}${after}`, start, end);
	const caret = start + before.length + text.length;
	field.setSelectionRange(caret, caret);
}

/**
 * a png data url, or undefined when the capture fails or runs past its deadline.
 * one over its budget is taken once more, scaled down by the area it overshot by
 */
function capture(element: Element): Promise<string | undefined> {
	const deadline = new Promise<undefined>((resolve) =>
		setTimeout(resolve, SCREENSHOT_DEADLINE_MS),
	);
	const shot = shoot(element, 1).then((first) => {
		const chars = first ? base64Of(first).length : 0;
		if (!first || chars <= MAX_SCREENSHOT_CHARS) return first;
		// png bytes grow about with pixel count, the square of the scale
		return shoot(
			element,
			RETRY_MARGIN * Math.sqrt(MAX_SCREENSHOT_CHARS / chars),
		);
	});
	return Promise.race([shot, deadline]);
}

function shoot(element: Element, scale: number): Promise<string | undefined> {
	return domToPng(element, {
		scale,
		timeout: ASSET_TIMEOUT_MS,
		maximumCanvasSize: MAX_CANVAS_SIDE,
	}).catch(() => undefined);
}

function location({ file, line, column }: Selection): string {
	return [file, line, column].filter((part) => part !== undefined).join(":");
}

/** a panel's top-left corner in the viewport */
interface Point {
	left: number;
	top: number;
}

function translate({ left, top }: Point): string {
	return `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

/** `panel` below the element, or above it when there's no room below, on screen */
function spotFor(panel: HTMLElement, rect: DOMRect): Point {
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
	return { left, top };
}

/** the point nearest `{ left, top }` that keeps `panel` a gap inside the viewport; its top-left edges win when it can't fit */
function inView(panel: HTMLElement, { left, top }: Point): Point {
	return {
		left: Math.min(
			Math.max(GAP, left),
			Math.max(GAP, innerWidth - panel.offsetWidth - GAP),
		),
		top: Math.min(
			Math.max(GAP, top),
			Math.max(GAP, innerHeight - panel.offsetHeight - GAP),
		),
	};
}

/** `tag` over the element's top-left corner, on screen */
function tagSpot(tag: HTMLElement, rect: DOMRect): Point {
	return {
		left: Math.min(Math.max(0, rect.left), innerWidth - tag.offsetWidth),
		top: Math.min(Math.max(0, rect.top), innerHeight - tag.offsetHeight),
	};
}

/**
 * `previous`, else the picked element, else its dialog; each only if it takes focus.
 * none does: focus is left where it falls
 */
function giveFocusBack(
	previous: HTMLElement | SVGElement | undefined,
	picked: Element | undefined,
): void {
	const dialog = picked?.closest(MODAL);
	for (const candidate of [previous, picked, dialog]) {
		if (
			!(candidate instanceof HTMLElement || candidate instanceof SVGElement) ||
			!candidate.isConnected
		)
			continue;
		candidate.focus({ preventScroll: true });
		if (tookFocus(candidate)) return;
	}
}

function tookFocus(element: Element): boolean {
	// a document or shadow root; either holds its own focused element
	const root = element.getRootNode();
	return "activeElement" in root && root.activeElement === element;
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
