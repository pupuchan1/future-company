import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { ProxyOptions } from "vite";

// Rewrite only a same-origin request. Cross-site requests retain their origin
// and are rejected by the corresponding backend's existing guards.
function localProxy(target: string, ws = false): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    ws,
    configure(proxy) {
      const origin = (
        request: { setHeader: (name: string, value: string) => void },
        incoming: { headers: Record<string, string | string[] | undefined> },
      ) => {
        if (incoming.headers.origin === `http://${incoming.headers.host}`)
          request.setHeader("origin", target);
      };
      proxy.on("proxyReq", origin);
      proxy.on("proxyReqWs", origin);
    },
  };
}
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api/status": localProxy("http://127.0.0.1:4320"),
      "/api/events": localProxy("http://127.0.0.1:4320"),
      "/api/live": localProxy("http://127.0.0.1:4320"),
      "/api/worker": localProxy("http://127.0.0.1:4320"),
      "/api/v1": localProxy("http://127.0.0.1:8787", true),
    },
  },
});
