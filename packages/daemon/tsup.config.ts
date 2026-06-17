import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli/index.ts"],
  format: "esm",
  target: "node18",
  platform: "node",
  bundle: true,
  splitting: false,
  noExternal: [/.*/],
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  banner: {
    js: `#!/usr/bin/env node
import { createRequire as __webbridgeCreateRequire } from "module";
const require = __webbridgeCreateRequire(import.meta.url);`,
  },
});
