import { spawn } from "node:child_process";

const processes = [
  spawn(process.execPath, ["apps/api/dist/index.js"], {
    stdio: "inherit",
    env: process.env
  }),
  spawn(process.execPath, ["apps/worker/dist/index.js"], {
    stdio: "inherit",
    env: process.env
  })
];

let exiting = false;

function shutdown(code = 0) {
  if (exiting) return;
  exiting = true;

  for (const child of processes) {
    if (!child.killed) child.kill("SIGTERM");
  }

  setTimeout(() => process.exit(code), 5000).unref();
}

for (const child of processes) {
  child.on("error", (error) => {
    console.error("child process error:", error);
    shutdown(1);
  });

  child.on("exit", (code, signal) => {
    console.log(`child exited: code=${code} signal=${signal ?? "none"}`);
    if (!exiting) shutdown(code ?? 1);
  });
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
