import { spawn } from "node:child_process";

const api = spawn(process.execPath, ["apps/api/dist/index.js"], {
  stdio: "inherit",
  env: process.env
});

const workerEnv = { ...process.env };
delete workerEnv.PORT;

const worker = spawn(process.execPath, ["apps/worker/dist/index.js"], {
  stdio: "inherit",
  env: workerEnv
});

let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  api.kill("SIGTERM");
  worker.kill("SIGTERM");

  setTimeout(() => process.exit(code), 5000).unref();
}

api.on("error", (err) => {
  console.error("api process error:", err);
  shutdown(1);
});

worker.on("error", (err) => {
  console.error("worker process error:", err);
  shutdown(1);
});

api.on("exit", (code) => {
  if (!shuttingDown) shutdown(code ?? 1);
});

worker.on("exit", (code) => {
  if (!shuttingDown) shutdown(code ?? 1);
});

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
