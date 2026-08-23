import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(() => {
  const webPort = Number(process.env.NEOCODE_WEB_PORT || 4317);
  const serverPort = Number(process.env.NEOCODE_SERVER_PORT || process.env.NEOCODE_PORT || 4318);
  const websocketTarget = process.env.NEOCODE_BACKEND_URL || `ws://127.0.0.1:${serverPort}`;
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
    server: {
      port: webPort,
      proxy: {
        "/ws": { target: websocketTarget, ws: true },
        "/health": `http://127.0.0.1:${serverPort}`,
      },
    },
  };
});
