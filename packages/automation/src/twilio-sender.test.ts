import { describe, expect, it } from "vitest";
import { MessageSendError } from "./ports";
import { TwilioSmsSender } from "./twilio-sender";

/** Real transport contract verified against a stub fetch (no network). */

const CONFIG = { accountSid: "AC123", authToken: "secret-token", fromNumber: "+15551234567" };

function fetchReturning(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe("TwilioSmsSender", () => {
  it("posts form-encoded with Basic auth and returns the provider sid", async () => {
    const captured: { url?: string | undefined; init?: RequestInit | undefined } = {};
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      captured.url = String(url);
      captured.init = init;
      return new Response(JSON.stringify({ sid: "SMabc123" }), { status: 201 });
    }) as typeof fetch;
    const sender = new TwilioSmsSender(CONFIG, fetchImpl);
    const result = await sender.send({ to: "+15557654321", body: "Hello!" });
    expect(result.providerRef).toBe("SMabc123");
    expect(captured.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect(captured.init?.method).toBe("POST");
    const auth = (captured.init?.headers as Record<string, string>)["authorization"];
    expect(auth).toBe(`Basic ${Buffer.from("AC123:secret-token").toString("base64")}`);
    const body = String(captured.init?.body);
    expect(body).toContain("To=%2B15557654321");
    expect(body).toContain("From=%2B15551234567");
    expect(body).toContain("Body=Hello%21");
  });

  it("classifies 4xx as terminal", async () => {
    const sender = new TwilioSmsSender(CONFIG, fetchReturning(400, { message: "Not a phone number", code: 21211 }));
    await expect(sender.send({ to: "+1", body: "x" })).rejects.toMatchObject({
      name: "MessageSendError",
      retryable: false,
      message: expect.stringContaining("Not a phone number"),
    });
  });

  it("classifies 429/5xx as retryable", async () => {
    for (const status of [429, 500, 503]) {
      const sender = new TwilioSmsSender(CONFIG, fetchReturning(status, { message: "busy" }));
      await expect(sender.send({ to: "+15557654321", body: "x" })).rejects.toMatchObject({
        retryable: true,
      });
    }
  });

  it("transport failures are retryable MessageSendErrors", async () => {
    const failing = (async () => {
      throw new Error("dns resolution failed");
    }) as typeof fetch;
    const sender = new TwilioSmsSender(CONFIG, failing);
    await expect(sender.send({ to: "+15557654321", body: "x" })).rejects.toMatchObject({
      name: "MessageSendError",
      retryable: true,
      message: expect.stringContaining("dns resolution failed"),
    });
  });

  it("tolerates non-JSON error bodies", async () => {
    const html = (async () => new Response("Service Unavailable", { status: 503 })) as typeof fetch;
    const sender = new TwilioSmsSender(CONFIG, html);
    await expect(sender.send({ to: "+15557654321", body: "x" })).rejects.toMatchObject({
      retryable: true,
      message: expect.stringContaining("HTTP 503"),
    });
  });

  it("maps a success without sid to a null providerRef", async () => {
    const sender = new TwilioSmsSender(CONFIG, fetchReturning(201, {}));
    const result = await sender.send({ to: "+15557654321", body: "x" });
    expect(result.providerRef).toBeNull();
  });
});
