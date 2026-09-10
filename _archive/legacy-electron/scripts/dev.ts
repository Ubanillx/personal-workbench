import { spawn, type ChildProcess } from "node:child_process";

const runtime = process.execPath;
const children: ChildProcess[] = [
  spawn(runtime, ["--watch", "--import", "tsx", "server/src/index.ts"], { stdio: "inherit" }),
  spawn(runtime, ["node_modules/vite/bin/vite.js", "--config", "web/vite.config.mts"], { stdio: "inherit" })
];

let shuttingDown = false;
const stop = (exitCode = 0): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = exitCode;
};

for (const child of children) {
  child.on("error", () => stop(1));
  child.on("exit", (code) => { if (!shuttingDown && code !== 0) stop(code ?? 1); });
}
process.once("SIGINT", () => stop());
process.once("SIGTERM", () => stop());
