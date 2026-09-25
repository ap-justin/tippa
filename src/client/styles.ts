// the app's inherited type and colors stop at the layer: everything is set here
export const css = `
.layer {
	/* all: initial leaves direction and custom properties as inherited */
	all: initial;
	direction: ltr;
	position: fixed;
	inset: 0;
	width: auto;
	height: auto;
	margin: 0;
	padding: 0;
	border: 0;
	background: transparent;
	overflow: visible;
	pointer-events: none;
	color-scheme: light dark;
	--ui-pick-bg: #fff;
	--ui-pick-fg: #1a1a1a;
	--ui-pick-muted: #666;
	--ui-pick-border: #d4d4d4;
	--ui-pick-focus: #2563eb;
	--ui-pick-error: #b91c1c;
	font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
	letter-spacing: normal;
	text-transform: none;
	color: var(--ui-pick-fg);
}
@media (prefers-color-scheme: dark) {
	.layer {
		--ui-pick-bg: #1f1f1f;
		--ui-pick-fg: #ededed;
		--ui-pick-muted: #a3a3a3;
		--ui-pick-border: #404040;
		--ui-pick-focus: #60a5fa;
		--ui-pick-error: #f87171;
	}
}
.panel {
	position: absolute;
	top: 0;
	left: 0;
	box-sizing: border-box;
	max-width: min(360px, calc(100vw - 16px));
	padding: 8px;
	border: 1px solid var(--ui-pick-border);
	border-radius: 6px;
	background: var(--ui-pick-bg);
	box-shadow: 0 4px 16px rgb(0 0 0 / 0.18);
	pointer-events: auto;
}
.panel[hidden] { display: none; }
.composer { width: 360px; display: grid; gap: 6px; }
label { font-weight: 600; }
.target, .notice { margin: 0; overflow-wrap: anywhere; }
.target { color: var(--ui-pick-muted); font-size: 12px; }
.notice { color: var(--ui-pick-error); }
textarea {
	box-sizing: border-box;
	width: 100%;
	min-height: 64px;
	resize: vertical;
	padding: 6px;
	border: 1px solid var(--ui-pick-border);
	border-radius: 4px;
	background: transparent;
	color: inherit;
	font: inherit;
}
.actions { display: flex; justify-content: flex-end; gap: 6px; }
button {
	padding: 4px 10px;
	border: 1px solid var(--ui-pick-border);
	border-radius: 4px;
	background: transparent;
	color: inherit;
	font: inherit;
	cursor: pointer;
}
button[type="submit"] { background: var(--ui-pick-fg); color: var(--ui-pick-bg); border-color: var(--ui-pick-fg); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
textarea:focus-visible, button:focus-visible {
	outline: 2px solid var(--ui-pick-focus);
	outline-offset: 1px;
}
.pick { display: grid; gap: 4px; justify-items: start; }
.pick-head { display: flex; align-items: center; gap: 6px; }
.badge {
	padding: 1px 6px;
	border: 1px solid var(--ui-pick-border);
	border-radius: 999px;
	font-size: 12px;
}
.badge[data-badge="question"] { border-color: var(--ui-pick-focus); color: var(--ui-pick-focus); }
.badge[data-badge="failed"] { border-color: var(--ui-pick-error); color: var(--ui-pick-error); }
.dismiss { padding: 0 6px; line-height: 1.2; }
/* while react-grab picks, the page under a marker stays pickable */
.layer[data-grabbing] .pick { pointer-events: none; }
.layer[data-grabbing] .dismiss { pointer-events: auto; }
.bubble { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 40vh; overflow: auto; }
.bubble:empty { display: none; }
`;
