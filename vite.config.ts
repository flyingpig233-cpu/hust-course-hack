import { defineConfig } from "vite";

// The frontend lives in `ui/`; Tauri loads `ui/dist` in production and the
// Vite dev server (port 1420) in development.
export default defineConfig({
  root: "ui",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome105",
  },
});
