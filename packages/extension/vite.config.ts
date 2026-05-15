import { defineConfig, type Plugin, build as viteBuild } from "vite";
import { resolve } from "path";
import { cpSync, mkdirSync, writeFileSync } from "fs";

function copyExtensionAssets(): Plugin {
  return {
    name: "copy-extension-assets",
    writeBundle() {
      const dist = resolve(__dirname, "dist");

      cpSync(resolve(__dirname, "manifest.json"), resolve(dist, "manifest.json"));

      cpSync(resolve(__dirname, "_locales"), resolve(dist, "_locales"), {
        recursive: true,
      });

      mkdirSync(resolve(dist, "icons"), { recursive: true });
    },
  };
}

function buildPopupHtml(): Plugin {
  return {
    name: "build-popup-html",
    writeBundle(_options, bundle) {
      const dist = resolve(__dirname, "dist");
      mkdirSync(resolve(dist, "popup"), { recursive: true });

      let popupJsFile = "popup.js";
      for (const key of Object.keys(bundle)) {
        if (key.startsWith("popup") && key.endsWith(".js")) {
          popupJsFile = key;
          break;
        }
      }

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>WebBridge</title>
  <style>
    body { width: 320px; min-height: 200px; margin: 0; font-family: system-ui, sans-serif; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="../${popupJsFile}"></script>
</body>
</html>`;

      writeFileSync(resolve(dist, "popup", "index.html"), html);
    },
  };
}

function buildContentScripts(): Plugin {
  return {
    name: "build-content-scripts",
    async closeBundle() {
      const contentEntries = ["cursor-overlay"];
      for (const name of contentEntries) {
        await viteBuild({
          configFile: false,
          build: {
            outDir: resolve(__dirname, "dist/content"),
            emptyOutDir: false,
            lib: {
              entry: resolve(__dirname, `src/content/${name}.ts`),
              name: `__webbridge_${name.replace(/-/g, "_")}`,
              formats: ["iife"],
              fileName: () => `${name}.js`,
            },
            rollupOptions: { output: { extend: true } },
            minify: true,
          },
          resolve: {
            alias: {
              "@webbridge/shared": resolve(__dirname, "../shared/src"),
            },
          },
        });
      }
    },
  };
}

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome120",
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background/index.ts"),
        popup: resolve(__dirname, "src/popup/main.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        format: "esm",
      },
    },
  },
  plugins: [copyExtensionAssets(), buildPopupHtml(), buildContentScripts()],
  resolve: {
    alias: {
      "@webbridge/shared": resolve(__dirname, "../shared/src"),
    },
  },
});
