import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  build: {
    // The only browser this bundle ever runs in is WebView2, which is evergreen
    // Chromium. Downleveling for anything older is work thrown away.
    target: "chrome120",
    // The gzip column next to every chunk costs several seconds on a bundle
    // this size — and the app loads from disk, where it means nothing.
    reportCompressedSize: false,
    // Same reason the gzip figure is off: mermaid, cytoscape, katex and the
    // language grammars are lazy chunks read from the local disk in a few
    // milliseconds. The 500 kB default is a network budget we do not pay.
    chunkSizeWarningLimit: 1500,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
