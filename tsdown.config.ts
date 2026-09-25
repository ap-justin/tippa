import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts", "src/channel/bin.ts"],
	format: "esm",
	platform: "node",
	dts: true,
});
