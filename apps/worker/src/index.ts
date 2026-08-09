import { startWorker } from "./server";

/**
 * Process entrypoint (P5: unhandled failures must never leave the process in
 * an undefined state — the supervisor restarts a crashed worker, a hung worker
 * serves nobody).
 */
startWorker().catch((error: unknown) => {
  // Logger may not exist yet (config validation failure) — last-resort line.
  console.error("worker.bootstrap.fatal", error);
  process.exitCode = 1;
});
