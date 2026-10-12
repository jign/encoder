import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    watch: { ignored: ["**/src-tauri/**", "**/.work/**"] },
    port: 1427,
    strictPort: true,
    fs: { allow: [".", "../../design/vanilla"] },
  },
  clearScreen: false,
});
