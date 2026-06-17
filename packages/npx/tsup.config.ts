import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["../cli/src/cli.ts"],
  outDir: "dist",
  format: ["esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: "node18",
  noExternal: ["@schift-io/ai-memory-core"],
});
