import { z } from "zod";
import {
  ConditionField,
  ConditionOperator,
  ShopifyWebhookTopic,
  WorkflowNodeKind,
  WorkflowTriggerKind,
} from "@profit/types";

/**
 * Workflow definition contract (M6). The definition jsonb stored in
 * `workflow_versions.definition` MUST pass these schemas — they are the
 * compile-time/backstop guarantee that the executor never walks an unshaped
 * graph (P1: no untyped JSON). Config limits are product decisions recorded
 * in the M6 doc (prevent runaway graphs + provider abuse).
 */

export const WORKFLOW_LIMITS = {
  maxNodes: 24,
  maxEdges: 48,
  maxDelayMinutes: 43_200, // 30 days
  maxEmailSubject: 200,
  maxEmailBodyText: 5_000,
  maxEmailBodyHtml: 20_000,
  maxSmsBody: 1_000,
  maxTagLength: 40,
  discountCodePattern: /^[A-Z0-9-]{4,32}$/,
  maxTemplateName: 140,
} as const;

export const nodeIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,79}$/, "node id: lowercase letters, digits, dashes");

export const conditionConfigSchema = z
  .object({
    field: z.enum(
      Object.values(ConditionField) as [ConditionField, ...ConditionField[]],
    ),
    operator: z.enum(
      Object.values(ConditionOperator) as [ConditionOperator, ...ConditionOperator[]],
    ),
    /** Compared after coercion: numbers stay numeric; booleans accept "true"/"false". */
    value: z.union([z.string().max(200), z.number(), z.boolean()]),
  })
  .strict();

export const delayConfigSchema = z
  .object({
    minutes: z.number().int().min(1).max(WORKFLOW_LIMITS.maxDelayMinutes),
  })
  .strict();

export const sendEmailConfigSchema = z
  .object({
    subject: z.string().min(1).max(WORKFLOW_LIMITS.maxEmailSubject),
    bodyText: z.string().min(1).max(WORKFLOW_LIMITS.maxEmailBodyText),
    bodyHtml: z.string().max(WORKFLOW_LIMITS.maxEmailBodyHtml).optional(),
  })
  .strict();

export const sendSmsConfigSchema = z
  .object({
    bodyText: z.string().min(1).max(WORKFLOW_LIMITS.maxSmsBody),
  })
  .strict();

export const tagCustomerConfigSchema = z
  .object({
    tag: z
      .string()
      .min(1)
      .max(WORKFLOW_LIMITS.maxTagLength)
      .regex(/^[^,]+$/, "tag must not contain commas"),
  })
  .strict();

export const createDiscountConfigSchema = z
  .object({
    code: z.string().regex(WORKFLOW_LIMITS.discountCodePattern, "code: 4-32 chars A-Z 0-9 -"),
    percentOff: z.number().int().min(1).max(50),
    expiresInDays: z.number().int().min(1).max(60),
  })
  .strict();

export const triggerConfigSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal(WorkflowTriggerKind.Manual) }).strict(),
  z
    .object({
      kind: z.literal(WorkflowTriggerKind.Schedule),
      /** Standard 5-field cron (UTC): minute hour day-of-month month day-of-week. */
      cron: z.string().min(9).max(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal(WorkflowTriggerKind.Event),
      topic: z.enum(
        Object.values(ShopifyWebhookTopic) as [ShopifyWebhookTopic, ...ShopifyWebhookTopic[]],
      ),
    })
    .strict(),
]);

export type TriggerConfig = z.infer<typeof triggerConfigSchema>;

const nodeConfigSchemas = {
  [WorkflowNodeKind.Trigger]: triggerConfigSchema,
  [WorkflowNodeKind.Condition]: conditionConfigSchema,
  [WorkflowNodeKind.Delay]: delayConfigSchema,
  [WorkflowNodeKind.SendEmail]: sendEmailConfigSchema,
  [WorkflowNodeKind.SendSms]: sendSmsConfigSchema,
  [WorkflowNodeKind.TagCustomer]: tagCustomerConfigSchema,
  [WorkflowNodeKind.CreateDiscount]: createDiscountConfigSchema,
} as const;

export const workflowNodeSchema = z
  .object({
    id: nodeIdSchema,
    kind: z.enum(Object.values(WorkflowNodeKind) as [WorkflowNodeKind, ...WorkflowNodeKind[]]),
    config: z.unknown(),
  })
  .strict();

export const workflowEdgeSchema = z
  .object({
    from: nodeIdSchema,
    to: nodeIdSchema,
    /** CONDITION outgoing branch selector; must be absent on other node kinds. */
    branch: z.union([z.literal("YES"), z.literal("NO")]).optional(),
  })
  .strict();

export const workflowDefinitionSchema = z
  .object({
    nodes: z.array(workflowNodeSchema).min(1).max(WORKFLOW_LIMITS.maxNodes),
    edges: z.array(workflowEdgeSchema).max(WORKFLOW_LIMITS.maxEdges),
  })
  .strict();

export type WorkflowNodeConfig = {
  [WorkflowNodeKind.Trigger]: TriggerConfig;
  [WorkflowNodeKind.Condition]: z.infer<typeof conditionConfigSchema>;
  [WorkflowNodeKind.Delay]: z.infer<typeof delayConfigSchema>;
  [WorkflowNodeKind.SendEmail]: z.infer<typeof sendEmailConfigSchema>;
  [WorkflowNodeKind.SendSms]: z.infer<typeof sendSmsConfigSchema>;
  [WorkflowNodeKind.TagCustomer]: z.infer<typeof tagCustomerConfigSchema>;
  [WorkflowNodeKind.CreateDiscount]: z.infer<typeof createDiscountConfigSchema>;
};

export interface WorkflowNode<K extends WorkflowNodeKind = WorkflowNodeKind> {
  readonly id: string;
  readonly kind: K;
  readonly config: WorkflowNodeConfig[K];
}

export interface WorkflowEdge {
  readonly from: string;
  readonly to: string;
  readonly branch?: "YES" | "NO";
}

export interface WorkflowDefinition {
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
}

/** Parse a node config against the schema for its kind (executor backstop). */
export function parseNodeConfig<K extends WorkflowNodeKind>(
  kind: K,
  raw: unknown,
): WorkflowNodeConfig[K] {
  const schema = nodeConfigSchemas[kind];
  return schema.parse(raw) as WorkflowNodeConfig[K];
}

export function nodeConfigSchemaFor(kind: WorkflowNodeKind): z.ZodType<unknown> {
  return nodeConfigSchemas[kind];
}

/**
 * Run subject (M6): the PII-minimal context a run carries — built by the API
 * on manual runs and by the worker's webhook fan-out on event triggers.
 * Conditions and template variables read ONLY from here (no hidden re-queries
 * mid-walk — deterministic replay).
 */
export const workflowSubjectSchema = z
  .object({
    customer: z
      .object({
        id: z.string().uuid(),
        shopifyCustomerId: z.string().max(64).nullable(),
        email: z.string().email().max(320).nullable(),
        firstName: z.string().max(255).nullable(),
        lastName: z.string().max(255).nullable(),
        phone: z.string().max(64).nullable(),
        ordersCount: z.number().int().min(0),
        totalSpentCents: z.number().int().min(0),
        acceptsMarketing: z.boolean(),
        tags: z.array(z.string().max(255)).max(200),
      })
      .partial()
      .strict()
      .nullable(),
    event: z
      .object({
        topic: z.string().max(64),
        totalCents: z.number().int().min(0).nullable(),
        currency: z.string().length(3).nullable(),
        orderId: z.string().max(64).nullable(),
        checkoutId: z.string().max(128).nullable(),
      })
      .partial()
      .strict()
      .nullable(),
  })
  .strict();

export type WorkflowSubject = z.infer<typeof workflowSubjectSchema>;

export const EMPTY_SUBJECT: WorkflowSubject = { customer: null, event: null };
