// Start the API (:3000) and the Vue app (:5173) together. Ctrl+C stops both.
import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const procs = [
  ["backend", ["run", "dev", "-w", "backend"]],
  ["frontend", ["run", "dev", "-w", "frontend"]],
].map(([name, args]) => {
  const p = spawn(npm, args, { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  const tag = (line) => line && console.log(`[${name}] ${line}`);
  p.stdout.on("data", (d) => String(d).split(/\r?\n/).forEach(tag));
  p.stderr.on("data", (d) => String(d).split(/\r?\n/).forEach(tag));
  p.on("exit", (code) => { console.log(`[${name}] exited with ${code}`); shutdown(code ?? 1); });
  return p;
});

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill();
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
