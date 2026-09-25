import { defineConfig } from "tsdown";

export default defineConfig([
	{
		entry: ["src/index.ts", "src/channel/bin.ts"],
		format: "esm",
		platform: "node",
		tsconfig: "tsconfig.node.json",
		dts: true,
	},
	{
		// served to the page by the plugin from dist/client/index.js
		entry: { "client/index": "src/client/index.ts" },
		format: "esm",
		platform: "browser",
		tsconfig: "tsconfig.client.json",
		dts: true,
		// the consumer's vite serves this file as-is, so it can't lean on bare imports resolving
		deps: {
			alwaysBundle: [/^react-grab(\/|$)/, /^bippy(\/|$)/, "modern-screenshot"],
			onlyBundle: ["react-grab", "bippy", "modern-screenshot"],
		},
	},
]);
