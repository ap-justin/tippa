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
	--tippa-bg: #fff;
	--tippa-fg: #1a1a1a;
	--tippa-muted: #666;
	--tippa-border: #d4d4d4;
	--tippa-focus: #2563eb;
	--tippa-error: #b91c1c;
	font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
	letter-spacing: normal;
	text-transform: none;
	color: var(--tippa-fg);
}
@media (prefers-color-scheme: dark) {
	.layer {
		--tippa-bg: #1f1f1f;
		--tippa-fg: #ededed;
		--tippa-muted: #a3a3a3;
		--tippa-border: #404040;
		--tippa-focus: #60a5fa;
		--tippa-error: #f87171;
	}
}
.panel {
	position: absolute;
	top: 0;
	left: 0;
	box-sizing: border-box;
	max-width: min(360px, calc(100vw - 16px));
	padding: 8px;
	border: 1px solid var(--tippa-border);
	border-radius: 6px;
	background: var(--tippa-bg);
	box-shadow: 0 4px 16px rgb(0 0 0 / 0.18);
	pointer-events: auto;
}
.panel[hidden] { display: none; }
.composer { width: 360px; display: grid; gap: 6px; }
.handle { cursor: move; touch-action: none; }
label { font-weight: 600; cursor: inherit; }
.target, .notice { margin: 0; overflow-wrap: anywhere; }
.target { color: var(--tippa-muted); font-size: 12px; }
.notice { color: var(--tippa-error); }
textarea {
	box-sizing: border-box;
	width: 100%;
	min-height: 64px;
	resize: vertical;
	padding: 6px;
	border: 1px solid var(--tippa-border);
	border-radius: 4px;
	background: transparent;
	color: inherit;
	font: inherit;
}
.elements { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.elements li { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.element-name { overflow-wrap: anywhere; }
.remove { padding: 0 6px; line-height: 1.2; }
.tag {
	position: absolute;
	top: 0;
	left: 0;
	padding: 1px 6px;
	border-radius: 999px;
	background: var(--tippa-fg);
	color: var(--tippa-bg);
	font-size: 12px;
}
.actions { display: flex; justify-content: flex-end; gap: 6px; }
button {
	padding: 4px 10px;
	border: 1px solid var(--tippa-border);
	border-radius: 4px;
	background: transparent;
	color: inherit;
	font: inherit;
	cursor: pointer;
}
button[type="submit"] { background: var(--tippa-fg); color: var(--tippa-bg); border-color: var(--tippa-fg); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
textarea:focus-visible, button:focus-visible, .handle:focus-visible {
	outline: 2px solid var(--tippa-focus);
	outline-offset: 1px;
}
.pick { display: grid; gap: 4px; justify-items: start; }
.pick-head { display: flex; align-items: center; gap: 6px; }
.badge {
	padding: 1px 6px;
	border: 1px solid var(--tippa-border);
	border-radius: 999px;
	font-size: 12px;
}
.badge[data-badge="question"] { border-color: var(--tippa-focus); color: var(--tippa-focus); }
.badge[data-badge="failed"] { border-color: var(--tippa-error); color: var(--tippa-error); }
.dismiss { padding: 0 6px; line-height: 1.2; }
/* while react-grab picks, the page under a marker stays pickable */
.layer[data-grabbing] .pick { pointer-events: none; }
.layer[data-grabbing] .dismiss { pointer-events: auto; }
.bubble { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 40vh; overflow: auto; }
.bubble:empty { display: none; }
`;
