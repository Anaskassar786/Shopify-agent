import { describe, expect, it } from "vitest";
import {
  AiProviderError,
  AppError,
  AuthenticationError,
  DatabaseError,
  ErrorCode,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "./errors";

describe("AppError", () => {
  it("exposes 4xx messages by default and hides 5xx messages", () => {
    const clientErr = new AppError(ErrorCode.Conflict, { httpStatus: 409, message: "conflict" });
    expect(clientErr.expose).toBe(true);

    const serverErr = new AppError(ErrorCode.Internal, { httpStatus: 500, message: "secret internals" });
    expect(serverErr.expose).toBe(false);
  });

  it("serializes to an ApiErrorItem without leaking optionality", () => {
    const err = new AppError(ErrorCode.NotFound, { httpStatus: 404, message: "gone", details: { id: "1" } });
    expect(err.toErrorItem()).toEqual({ code: ErrorCode.NotFound, message: "gone", details: { id: "1" } });
  });
});

describe("specialized errors", () => {
  it("ValidationError carries flattened field errors from zod issues", () => {
    const err = ValidationError.fromZod([
      { path: ["settings", "timezone"], message: "Required", code: "invalid_type" },
    ]);
    expect(err.httpStatus).toBe(400);
    expect(err.fieldErrors[0]?.field).toBe("settings.timezone");
    expect(err.fieldErrors[0]?.code).toBe(ErrorCode.ValidationFailed);
  });

  it("root-level zod issues map to (root)", () => {
    const err = ValidationError.fromZod([{ path: [], message: "bad", code: "custom" }]);
    expect(err.fieldErrors[0]?.field).toBe("(root)");
  });

  it("status mapping is correct across the taxonomy", () => {
    expect(new AuthenticationError().httpStatus).toBe(401);
    expect(new ForbiddenError().httpStatus).toBe(403);
    expect(new NotFoundError("Order").httpStatus).toBe(404);
    expect(new NotFoundError("Order").message).toBe("Order not found");
    expect(new RateLimitError(30).httpStatus).toBe(429);
    expect(new AiProviderError("gemini down").httpStatus).toBe(502);
    expect(new DatabaseError().httpStatus).toBe(500);
    expect(new DatabaseError().expose).toBe(false);
  });
});
