import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger";

/** Collecting destination so we can assert on the emitted JSON lines. */
function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  return { stream, lines };
}

describe("createLogger", () => {
  it("emits structured JSON with service bindings", () => {
    const { stream, lines } = capture();
    const logger = createLogger({ level: "info", service: "api", environment: "test", destination: stream });
    logger.info({ requestId: "req_1" }, "test.event");
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(parsed["msg"]).toBe("test.event");
    expect(parsed["service"]).toBe("api");
    expect(parsed["requestId"]).toBe("req_1");
    expect(parsed["level"]).toBe("info");
  });

  it("REDACTS credential-shaped fields (P5: never log secrets)", () => {
    const { stream, lines } = capture();
    const logger = createLogger({ level: "info", service: "api", environment: "test", destination: stream });
    logger.info(
      {
        password: "hunter2",
        nested: { accessToken: "fake_access_token_value_xxx", refreshToken: "rt_xxx", apiKey: "ak_xxx" },
      },
      "security.test",
    );
    const raw = lines.join("");
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("fake_access_token_value_xxx");
    expect(raw).not.toContain("rt_xxx");
    expect(raw).not.toContain("ak_xxx");
    expect(raw).toContain("[REDACTED]");
  });
});
