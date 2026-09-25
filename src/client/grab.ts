import { formatElementInfo, init, type ReactGrabAPI } from "react-grab/core";
import type { Selection } from "./payload.ts";
import { toSelection } from "./selection.ts";

declare global {
	interface Window {
		// react-grab's own entry reads and sets this; typed there, not in `react-grab/core`
		__REACT_GRAB__?: ReactGrabAPI;
	}
}

/** `selection` is undefined when react-grab found no source file and line */
export type OnPick = (
	element: Element,
	selection: Selection | undefined,
) => void;

/**
 * adds "Send to Claude" to react-grab's menu. joins the page's react-grab when it
 * already runs one; otherwise starts one and publishes it the way react-grab's
 * entry does, so an app that imports react-grab later reuses it instead of
 * drawing a second picker.
 */
export function startGrab(key: string | undefined, onPick: OnPick): void {
	const grab = window.__REACT_GRAB__ ?? publish(init({ telemetry: false }));
	// the plugin's `key` option was set on purpose, so it wins over the app's own react-grab config
	if (key) grab.setOptions({ activationKey: key });
	grab.registerPlugin({
		name: "ui-pick",
		actions: [
			{
				id: "ui-pick-send",
				label: "Send to Claude",
				showInToolbarMenu: true,
				async onAction({ element, componentName, tagName, cleanup }) {
					// react-grab's frozen styles must be gone before the screenshot
					cleanup();
					const [source, html] = await Promise.all([
						grab.getSource(element),
						formatElementInfo(element),
					]);
					onPick(
						element,
						toSelection({
							source,
							fallbackName:
								componentName ?? grab.getDisplayName(element) ?? undefined,
							tagName: tagName ?? element.localName,
							html,
						}),
					);
				},
			},
		],
	});
}

function publish(api: ReactGrabAPI): ReactGrabAPI {
	window.__REACT_GRAB__ = api;
	return api;
}
