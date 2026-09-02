import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import electron from "vite-plugin-electron";
import electronRenderer from "vite-plugin-electron-renderer";
import { resolve } from "path";
import { copyFileSync, existsSync, mkdirSync } from "fs";

// ============================================================
// 在 Vite 启动前就把 preload.cjs 复制到 dist-electron/
// 这是纯 CJS JS 文件，不需要 Vite 编译
// ============================================================
const preloadSrc = resolve(__dirname, "electron", "preload.cjs");
const preloadDest = resolve(__dirname, "dist-electron", "preload.cjs");
if (!existsSync(resolve(__dirname, "dist-electron"))) {
  mkdirSync(resolve(__dirname, "dist-electron"), { recursive: true });
}
copyFileSync(preloadSrc, preloadDest);
console.log("[preload] copied to dist-electron/preload.cjs");

export default defineConfig({
  plugins: [
    vue(),
    electron([
      {
        entry: "electron/main.ts",
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: {
              external: ["electron"],
            },
          },
        },
      },
      {
        entry: "electron/preload-anim.ts",
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: {
              external: ["electron"],
            },
          },
        },
      },
    ]),
    electronRenderer(),
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
