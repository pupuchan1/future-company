import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const envFile = fileURLToPath(new URL("../.env.local", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
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
console.log(
  "Local reception: http://127.0.0.1:5173 (voice: 4320, Worker: 8787)",
);
run("Voice backend", ["run", "integration"]);
run("Worker backend", ["run", "dev:worker"]);
run("React", ["run", "dev:frontend", "--", "--port", "5173", "--strictPort"]);
