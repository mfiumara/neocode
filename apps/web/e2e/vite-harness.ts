import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createViteServer, type InlineConfig, type ViteDevServer } from "vite";

export interface IsolatedViteServer {
  vite: ViteDevServer;
  http: HttpServer;
  port: number;
  close(): Promise<void>;
}

/**
 * Run Vite on an already-owned HTTP server bound with port 0. Vite's ordinary
 * port option treats zero as its 5173 default, so middleware mode is required
 * for true kernel assignment rather than fixed-port probing.
 */
export async function startViteOnKernelPort(config: InlineConfig): Promise<IsolatedViteServer> {
  const http = createHttpServer();
  const vite = await createViteServer({
    ...config,
    server: {
      ...config.server,
      middlewareMode: { server: http },
      hmr: { ...config.server?.hmr as object, server: http },
    },
  });
  http.on("request", (request, response) => {
    vite.middlewares(request, response, () => {
      response.statusCode = 404;
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const address = http.address();
  if (!address || typeof address !== "object" || address.port <= 0) throw new Error("Vite harness did not receive a kernel-assigned port");
  return {
    vite,
    http,
    port: address.port,
    async close() {
      await vite.close();
      http.closeAllConnections();
      if (http.listening) await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
