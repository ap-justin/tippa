import type { ClientConfig } from "../protocol.ts";

export type { ClientConfig };

/**
 * called once per page by the plugin's loader. subscribe to `ui-pick:status` and
 * `ui-pick:reply` on `import.meta.hot` before returning: the loader asks for the
 * current status right after.
 */
export function start(_config: ClientConfig): void {}
