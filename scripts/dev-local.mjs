import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { loadServerEnvironment } from "../integration/environment.mjs";
import { requireRelaySecret } from "../deployment/protocol.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
loadServerEnvironment(new URL("../", import.meta.url));
process.env.INTEGRATION_PORT ||= "4320";
process.env.NODE_RELAY_PORT ||= "4330";
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Start with npm run dev.");
const children = new Set();
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      process.platform === "win32"
        ? child.kill("SIGTERM")
        : process.kill(-child.pid, "SIGTERM");
    } catch {
      /* Already stopped. */
    }
  }
  process.exitCode = code;
}
function run(name, args) {
  const child = spawn(process.execPath, [npm, ...args], {
    cwd: root,
    stdio: "inherit",
    detached: process.platform !== "win32",
    env: { ...process.env, CI: "1" },
  });
  children.add(child);
  child.on("error", () => {
    console.error(`${name} could not start.`);
    stop(1);
  });
  child.on("exit", (code) => {
    children.delete(child);
    if (!stopping) {
      console.error(`${name} stopped (${code ?? "signal"}).`);
      stop(code || 1);
    }
  });
  return child;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop());
if (process.argv.includes("--mcp-tunnel")) {
  try {
    requireRelaySecret(process.env.NODE_RELAY_SECRET);
    requireRelaySecret(process.env.HUMAN_MCP_TOKEN);
    // Never expose a service already using the relay port.
    await new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once("error", () => reject(new Error("The local relay port is already in use.")));
      probe.listen(Number(process.env.NODE_RELAY_PORT), "127.0.0.1", () => probe.close(resolve));
    });
    await new Promise((resolve, reject) => {
      const tunnel = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${process.env.NODE_RELAY_PORT}`, "--no-autoupdate"], {
        cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
      });
      children.add(tunnel);
      const timer = setTimeout(() => reject(new Error("MCP tunnel did not become ready.")), 30000);
      let output = "";
      let ready = false;
      const receive = chunk => {
        if (ready) return;
        output = (output + chunk.toString()).slice(-8192);
        const url = output.match(/https:\/\/[a-z-]+\.trycloudflare\.com/);
        if (!url) return;
        ready = true; clearTimeout(timer);
        process.env.HUMAN_MCP_URL = `${url[0]}/mcp`;
        console.log("Authenticated local MCP tunnel ready.");
        resolve();
      };
      tunnel.stdout.on("data", receive);
      tunnel.stderr.on("data", receive);
      tunnel.on("error", () => { clearTimeout(timer); reject(new Error("Could not start cloudflared.")); });
      tunnel.on("exit", code => {
        clearTimeout(timer); children.delete(tunnel);
        if (!ready) reject(new Error("MCP tunnel stopped before becoming ready."));
        if (!stopping) stop(code || 1);
      });
    });
  } catch (error) {
    console.error(error.message); stop(1);
  }
}
if (stopping) process.exit(1);
console.log(
  "Local reception: http://127.0.0.1:5173 (voice: 4320, relay: 4330, Worker: 8787)",
);
// UI-only local development still starts without inventing or saving credentials.
const relayConfigured = Boolean(process.env.NODE_RELAY_SECRET && process.env.HUMAN_MCP_TOKEN);
run(relayConfigured ? "Voice backend and relay" : "Voice backend", ["run", relayConfigured ? "integration:relay" : "integration"]);
run("Worker backend", ["run", "dev:worker"]);
run("React", ["run", "dev:frontend", "--", "--port", "5173", "--strictPort"]);
