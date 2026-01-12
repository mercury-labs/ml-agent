import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  target: "node18",
  platform: "node",
  sourcemap: true,
  dts: true,
  clean: true,
  splitting: false
});
