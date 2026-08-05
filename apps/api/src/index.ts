import { startServer } from "./server";

/**
 * Process entry. Fatal boot errors (env validation, port bind) log once to
 * stderr and exit non-zero so the platform restarts visibly instead of
 * running a silently misconfigured instance (P5: fail fast).
 */

process.on("unhandledRejection", (reason: unknown) => {
  console.error(JSON.stringify({ level: "fatal", msg: "unhandledRejection", reason: String(reason) }));
  process.exit(1);
});

process.on("uncaughtException", (error: unknown) => {
  console.error(JSON.stringify({ level: "fatal", msg: "uncaughtException", error: String(error) }));
  process.exit(1);
});

try {
  await startServer();
} catch (error) {
  console.error(
    JSON.stringify({
      level: "fatal",
      msg: "api.boot.failed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
}
