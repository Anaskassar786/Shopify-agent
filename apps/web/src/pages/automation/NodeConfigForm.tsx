import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { ConditionField, ConditionOperator, ShopifyWebhookTopic } from "@profit/types";
import { Input, Select, Textarea } from "@profit/ui";
import { defaultConfigFor, TEMPLATE_VARIABLES, type BuilderNode } from "./workflow-builder";

/**
 * Per-kind node configuration form (M6). Writes raw config key/values up to
 * the workspace draft; bounds mirror definition.ts exactly (the server zod
 * schemas remain the authoritative backstop and surface 400s on save).
 */

const NUMBER_CONDITION_FIELDS: ReadonlySet<string> = new Set([
  ConditionField.CustomerOrdersCount,
  ConditionField.CustomerTotalSpentCents,
  ConditionField.EventTotalCents,
]);

const BOOLEAN_CONDITION_FIELDS: ReadonlySet<string> = new Set([ConditionField.CustomerAcceptsMarketing]);

const OPERATOR_LABEL: Readonly<Record<string, string>> = {
  EQ: "equals",
  NEQ: "does not equal",
  GT: "is greater than",
  GTE: "is at least",
  LT: "is less than",
  LTE: "is at most",
  CONTAINS: "contains",
};

function Field({ label, hint, children }: { readonly label: string; readonly hint?: string; readonly children: ReactNode }): ReactNode {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint !== undefined && <span className="mt-1 block text-[11px] leading-relaxed text-faint">{hint}</span>}
    </label>
  );
}

function TemplateVarsHint(): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-subtle bg-surface px-3 py-2">
      <button
        type="button"
        className="flex w-full items-center justify-between text-[11px] font-semibold text-muted"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        Personalization variables
        <ChevronRight className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
      </button>
      {open && (
        <div className="mt-2 flex flex-wrap gap-1">
          {TEMPLATE_VARIABLES.map((variable) => (
            <code key={variable} className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] text-muted">
              {`{{${variable}}}`}
            </code>
          ))}
        </div>
      )}
    </div>
  );
}

export function NodeConfigForm({
  node,
  onPatchConfig,
  onReplaceConfig,
}: {
  readonly node: BuilderNode;
  /** Merge a partial config patch (all field edits). */
  readonly onPatchConfig: (patch: Record<string, unknown>) => void;
  /** Replace the whole config (trigger-kind switches reset the shape). */
  readonly onReplaceConfig: (config: Record<string, unknown>) => void;
}): ReactNode {
  const c = node.config;

  if (node.kind === "TRIGGER") {
    const kind = typeof c["kind"] === "string" ? c["kind"] : "MANUAL";
    return (
      <div className="flex flex-col gap-4">
        <Field label="What starts a run">
          <Select
            value={kind}
            onChange={(event) =>
              onReplaceConfig(defaultConfigFor("TRIGGER", event.target.value as "MANUAL" | "SCHEDULE" | "EVENT"))
            }
            aria-label="Trigger kind"
          >
            <option value="MANUAL">Manual — you run it by hand</option>
            <option value="SCHEDULE">Schedule — recurring cron (UTC)</option>
            <option value="EVENT">Store event — fires from Shopify webhooks</option>
          </Select>
        </Field>
        {kind === "SCHEDULE" && (
          <Field
            label="Cron expression"
            hint="Five fields in UTC: minute hour day-of-month month day-of-week. Example: 0 9 * * 1 = Mondays 09:00."
          >
            <Input
              value={typeof c["cron"] === "string" ? c["cron"] : ""}
              onChange={(event) => onPatchConfig({ cron: event.target.value })}
              placeholder="0 9 * * *"
              aria-label="Cron expression"
            />
          </Field>
        )}
        {kind === "EVENT" && (
          <Field label="Shopify event topic" hint="Runs fire once per real webhook delivery.">
            <Select
              value={typeof c["topic"] === "string" ? c["topic"] : "orders/create"}
              onChange={(event) => onPatchConfig({ topic: event.target.value })}
              aria-label="Event topic"
            >
              {Object.values(ShopifyWebhookTopic).map((topic) => (
                <option key={topic} value={topic}>
                  {topic}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
    );
  }

  if (node.kind === "CONDITION") {
    const field = typeof c["field"] === "string" ? c["field"] : ConditionField.CustomerOrdersCount;
    const operator = typeof c["operator"] === "string" ? c["operator"] : "GTE";
    return (
      <div className="flex flex-col gap-4">
        <Field label="Check this fact">
          <Select
            value={field}
            onChange={(event) => {
              const next = event.target.value;
              const value = NUMBER_CONDITION_FIELDS.has(next)
                ? 0
                : BOOLEAN_CONDITION_FIELDS.has(next)
                  ? true
                  : "";
              onPatchConfig({ field: next, value });
            }}
            aria-label="Condition field"
          >
            {Object.values(ConditionField).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Operator">
          <Select value={operator} onChange={(event) => onPatchConfig({ operator: event.target.value })} aria-label="Condition operator">
            {Object.values(ConditionOperator).map((value) => (
              <option key={value} value={value}>
                {OPERATOR_LABEL[value] ?? value}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Compare against">
          {NUMBER_CONDITION_FIELDS.has(field) ? (
            <Input
              type="number"
              value={typeof c["value"] === "number" ? c["value"] : 0}
              onChange={(event) => onPatchConfig({ value: Number(event.target.value) })}
              aria-label="Condition value"
            />
          ) : BOOLEAN_CONDITION_FIELDS.has(field) ? (
            <Select
              value={c["value"] === true ? "true" : "false"}
              onChange={(event) => onPatchConfig({ value: event.target.value === "true" })}
              aria-label="Condition value"
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </Select>
          ) : (
            <Input
              value={typeof c["value"] === "string" ? c["value"] : ""}
              onChange={(event) => onPatchConfig({ value: event.target.value })}
              aria-label="Condition value"
              placeholder={field === ConditionField.CustomerTag ? "vip" : "USD"}
            />
          )}
        </Field>
        <p className="text-[11px] leading-relaxed text-faint">
          YES runs when the check passes, NO when it does not — connect both paths on the canvas.
        </p>
      </div>
    );
  }

  if (node.kind === "DELAY") {
    const minutes = typeof c["minutes"] === "number" ? c["minutes"] : 60;
    return (
      <Field
        label="Wait (minutes)"
        hint={`≈ ${minutes >= 1440 ? `${String(Math.round((minutes / 1440) * 10) / 10)} days` : minutes >= 60 ? `${String(Math.round((minutes / 60) * 10) / 10)} hours` : `${String(minutes)} minutes`} · max 30 days (43200).`}
      >
        <Input
          type="number"
          min={1}
          max={43_200}
          value={minutes}
          onChange={(event) => onPatchConfig({ minutes: Math.max(1, Math.round(Number(event.target.value))) })}
          aria-label="Wait minutes"
        />
      </Field>
    );
  }

  if (node.kind === "SEND_EMAIL") {
    return (
      <div className="flex flex-col gap-4">
        <Field label="Subject">
          <Input
            value={typeof c["subject"] === "string" ? c["subject"] : ""}
            maxLength={200}
            onChange={(event) => onPatchConfig({ subject: event.target.value })}
            aria-label="Email subject"
            placeholder="We miss you, {{customer.firstName}}"
          />
        </Field>
        <Field label="Body (plain text)">
          <Textarea
            value={typeof c["bodyText"] === "string" ? c["bodyText"] : ""}
            rows={5}
            maxLength={5_000}
            onChange={(event) => onPatchConfig({ bodyText: event.target.value })}
            aria-label="Email body"
          />
        </Field>
        <Field label="Body (HTML, optional)" hint="When present, emails send as multipart with the plain-text body as fallback.">
          <Textarea
            value={typeof c["bodyHtml"] === "string" ? c["bodyHtml"] : ""}
            rows={3}
            maxLength={20_000}
            onChange={(event) => onPatchConfig(event.target.value === "" ? { bodyHtml: undefined } : { bodyHtml: event.target.value })}
            aria-label="Email HTML body"
          />
        </Field>
        <TemplateVarsHint />
      </div>
    );
  }

  if (node.kind === "SEND_SMS") {
    return (
      <div className="flex flex-col gap-4">
        <Field label="Message" hint="Delivered to customers with a phone number; the unsubscribe line is appended automatically.">
          <Textarea
            value={typeof c["bodyText"] === "string" ? c["bodyText"] : ""}
            rows={4}
            maxLength={1_000}
            onChange={(event) => onPatchConfig({ bodyText: event.target.value })}
            aria-label="SMS body"
          />
        </Field>
        <TemplateVarsHint />
      </div>
    );
  }

  if (node.kind === "TAG_CUSTOMER") {
    return (
      <Field label="Tag to apply" hint="Single tag, no commas — written onto the customer in Shopify.">
        <Input
          value={typeof c["tag"] === "string" ? c["tag"] : ""}
          maxLength={40}
          onChange={(event) => onPatchConfig({ tag: event.target.value })}
          aria-label="Customer tag"
          placeholder="won-back"
        />
      </Field>
    );
  }

  if (node.kind === "CREATE_DISCOUNT") {
    return (
      <div className="flex flex-col gap-4">
        <Field label="Discount code" hint="4–32 characters: A–Z, 0–9 and dashes. Minted in Shopify at send time.">
          <Input
            value={typeof c["code"] === "string" ? c["code"] : ""}
            onChange={(event) => onPatchConfig({ code: event.target.value.toUpperCase() })}
            aria-label="Discount code"
            placeholder="WINBACK-10"
          />
        </Field>
        <Field label="Percent off (1–50)">
          <Input
            type="number"
            min={1}
            max={50}
            value={typeof c["percentOff"] === "number" ? c["percentOff"] : 10}
            onChange={(event) => onPatchConfig({ percentOff: Math.round(Number(event.target.value)) })}
            aria-label="Percent off"
          />
        </Field>
        <Field label="Expires after (days, 1–60)">
          <Input
            type="number"
            min={1}
            max={60}
            value={typeof c["expiresInDays"] === "number" ? c["expiresInDays"] : 30}
            onChange={(event) => onPatchConfig({ expiresInDays: Math.round(Number(event.target.value)) })}
            aria-label="Expires after days"
          />
        </Field>
      </div>
    );
  }

  return <p className="text-sm text-muted">This node has no configuration.</p>;
}
