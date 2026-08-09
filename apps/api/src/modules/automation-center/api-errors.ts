import {
  AccessOverrideNotFoundError,
  AccessOverrideStateError,
  BillingConflictError,
} from "@profit/billing";
import {
  CampaignNotFoundError,
  CampaignStateError,
  TemplateConflictError,
  TemplateNotFoundError,
} from "@profit/automation";
import {
  ExportNotFoundError,
  ExportStateError,
  ExportTooLargeError,
} from "@profit/automation";
import { TicketNotFoundError, TicketStateError } from "@profit/automation";
import {
  WorkflowNotFoundError,
  WorkflowStateError,
  WorkflowValidationError,
} from "@profit/automation";
import { AppError, ConflictError, ErrorCode, ValidationError } from "../../lib/errors";

/**
 * M6 automation-plane error parity: every service-layer typed error maps to
 * exactly one transport error, so routers never leak internal error classes
 * across the HTTP boundary (P2 disciplined error surfacing; mirrors the
 * billing router's instanceof mapping, centralized for the five routers).
 */
export function toAutomationApiError(error: unknown): AppError {
  if (
    error instanceof WorkflowNotFoundError ||
    error instanceof CampaignNotFoundError ||
    error instanceof TemplateNotFoundError ||
    error instanceof ExportNotFoundError ||
    error instanceof TicketNotFoundError ||
    error instanceof AccessOverrideNotFoundError
  ) {
    // The service message ("campaign {id} not found") is already the honest detail.
    return new AppError(ErrorCode.NotFound, { httpStatus: 404, message: error.message, expose: true });
  }
  if (
    error instanceof WorkflowStateError ||
    error instanceof CampaignStateError ||
    error instanceof TemplateConflictError ||
    error instanceof ExportStateError ||
    error instanceof TicketStateError ||
    error instanceof AccessOverrideStateError ||
    error instanceof BillingConflictError
  ) {
    return new ConflictError(error.message);
  }
  if (error instanceof WorkflowValidationError) {
    return new ValidationError(`invalid workflow definition: ${error.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  }
  if (error instanceof ExportTooLargeError) {
    return new ValidationError(error.message);
  }
  if (error instanceof AppError) return error;
  return new AppError(ErrorCode.Internal, {
    httpStatus: 500,
    message: "Unexpected automation error",
    expose: false,
    ...(error instanceof Error ? { cause: error } : {}),
  });
}

/**
 * Pass-through variant for router catch blocks: zod/express errors must
 * reach the global handler untouched (it owns their 400 serialization);
 * only the M6 service error classes translate.
 */
export function passThroughAutomationError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  const mappedSemantics =
    error instanceof WorkflowNotFoundError ||
    error instanceof CampaignNotFoundError ||
    error instanceof TemplateNotFoundError ||
    error instanceof ExportNotFoundError ||
    error instanceof TicketNotFoundError ||
    error instanceof AccessOverrideNotFoundError ||
    error instanceof WorkflowStateError ||
    error instanceof CampaignStateError ||
    error instanceof TemplateConflictError ||
    error instanceof ExportStateError ||
    error instanceof TicketStateError ||
    error instanceof AccessOverrideStateError ||
    error instanceof BillingConflictError ||
    error instanceof WorkflowValidationError ||
    error instanceof ExportTooLargeError;
  return mappedSemantics ? toAutomationApiError(error) : error;
}
