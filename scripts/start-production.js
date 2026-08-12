const { spawn } = require("node:child_process");

const children = [
  spawn("node", ["apps/api/dist/index.js"], {
    stdio: "inherit",
    env: process.env,
  }),
  spawn("node", ["apps/worker/dist/index.js"], {
    stdio: "inherit",
    env: process.env,
  }),
];

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(
        `Required child exited: code=${code}, signal=${signal}`
      );
      shutdown("SIGTERM");
      process.exit(code ?? 1);
    }
  });
}
