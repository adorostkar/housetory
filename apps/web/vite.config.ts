import { cpSync, createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

// The PDF viewer (src/components/pdf-pages.tsx) asks pdf.js for image decoders,
// character maps and the standard fonts by fixed file name, so they are served as
// plain files under a folder named after the pdf.js version.
const pdfjsDir = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const pdfjsVersion = (
  JSON.parse(readFileSync(path.join(pdfjsDir, "package.json"), "utf8")) as { version: string }
).version;
const pdfjsDataUrl = `/assets/pdfjs-${pdfjsVersion}/`;
const pdfjsDataDirs = ["wasm", "cmaps", "standard_fonts"];
// WebAssembly is blocked by the production CSP, so only the plain JavaScript
// decoders are shipped. The scripting sandbox is never used.
const isPdfjsData = (file: string) => !/\.wasm$|quickjs/.test(file);

function pdfjsData(): Plugin {
  let outDir = "";
  return {
    name: "housetory:pdfjs-data",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use(pdfjsDataUrl, (request, response, next) => {
        const name = decodeURIComponent((request.url ?? "").split("?")[0] ?? "");
        const file = path.join(pdfjsDir, name);
        const allowed = pdfjsDataDirs.some((dir) =>
          file.startsWith(path.join(pdfjsDir, dir) + path.sep),
        );
        if (!allowed || !isPdfjsData(file) || !existsSync(file) || !statSync(file).isFile()) {
          next();
          return;
        }
        if (file.endsWith(".js")) response.setHeader("Content-Type", "text/javascript");
        createReadStream(file).pipe(response);
      });
    },
    writeBundle() {
      for (const dir of pdfjsDataDirs) {
        cpSync(path.join(pdfjsDir, dir), path.join(outDir, pdfjsDataUrl, dir), {
          recursive: true,
          filter: isPdfjsData,
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfjsData()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:8000",
        changeOrigin: false,
      },
    },
  },
  build: {
    target: "es2022",
    sourcemap: false,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    restoreMocks: true,
    css: false,
  },
});
