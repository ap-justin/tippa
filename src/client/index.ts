import type { ClientConfig } from "../protocol.ts";
import { listen, PickController } from "./controller.ts";
import { startGrab } from "./grab.ts";
import { mountOverlay } from "./overlay.ts";

export type { ClientConfig };

/**
 * called once per page by the plugin's loader. subscribe to `tippa:status` and
 * `tippa:reply` on `import.meta.hot` before returning: the loader asks for the
 * current status right after.
 */
export function start(config: ClientConfig): void {
	// wrapped: window.fetch called with the controller as `this` throws "illegal invocation"
	const controller = new PickController(config, (input, init) =>
		fetch(input, init),
	);
	if (import.meta.hot) listen(import.meta.hot, controller);
	startGrab(config.key, mountOverlay(controller));
}
