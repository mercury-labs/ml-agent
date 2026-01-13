import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  target: "node18",
  platform: "node",
  external: ["playwright"],
  sourcemap: true,
  dts: true,
  clean: true,
  splitting: false
});
