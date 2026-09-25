import { defineConfig } from "tsdown";

export default defineConfig([
	{
		entry: ["src/index.ts", "src/channel/bin.ts"],
		format: "esm",
		platform: "node",
		dts: true,
	},
	{
		// served to the page by the plugin from dist/client/index.js
		entry: { "client/index": "src/client/index.ts" },
		format: "esm",
		platform: "browser",
		dts: true,
	},
]);
