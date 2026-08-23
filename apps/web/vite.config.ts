import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  server: {
    port: 4317,
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:4318",
        ws: true,
      },
      "/health": "http://127.0.0.1:4318",
    },
  },
});
