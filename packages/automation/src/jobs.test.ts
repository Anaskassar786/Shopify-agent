import { describe, expect, it } from "vitest";
import { QueueName, WorkflowTriggerKind } from "@profit/types";
import {
  AutomationTickJob,
  CampaignDispatchJob,
  CampaignSendBatchJob,
  ExportGenerateJob,
  SupportNotifyJob,
  WorkflowRunResumeJob,
  WorkflowRunStartJob,
} from "./jobs";

/** Job contract pins: names/queues/payload validation (P3 taxonomy). */

describe("M6 job definitions", () => {
  const all = [
    AutomationTickJob,
    WorkflowRunStartJob,
    WorkflowRunResumeJob,
    CampaignDispatchJob,
    CampaignSendBatchJob,
    ExportGenerateJob,
    SupportNotifyJob,
  ];

  it("have distinct <domain>.<verb> names on declared queues", () => {
    const names = all.map((j) => j.name);
    expect(new Set(names).size).toBe(names.length);
    for (const job of all) {
      expect(job.name).toMatch(/^[a-z]+\.[a-z-]+$/);
      expect(Object.values(QueueName)).toContain(job.queue);
    }
  });

  it("queue assignment: automation plane vs export vs notification", () => {
    expect(AutomationTickJob.queue).toBe(QueueName.Automation);
    expect(WorkflowRunStartJob.queue).toBe(QueueName.Automation);
    expect(CampaignSendBatchJob.queue).toBe(QueueName.Automation);
    expect(ExportGenerateJob.queue).toBe(QueueName.Export);
    expect(SupportNotifyJob.queue).toBe(QueueName.Notification);
  });

  it("run-start accepts a full event payload", () => {
    const payload = {
      storeId: "7f2b8c4a-3e1d-4f6a-9b8c-2d7e5a1c3b9d",
      workflowId: "8f2b8c4a-3e1d-4f6a-9b8c-2d7e5a1c3b9d",
      triggerKind: WorkflowTriggerKind.Event,
      triggerEventId: "webhook:delivery-1",
      subject: {
        customer: {
          id: "9f2b8c4a-3e1d-4f6a-9b8c-2d7e5a1c3b9d",
          tags: ["vip"],
        },
        event: { topic: "orders/create", totalCents: 4200 },
      },
    };
    expect(WorkflowRunStartJob.schema.safeParse(payload).success).toBe(true);
  });

  it("run-start rejects extras and bad subjects", () => {
    const base = {
      storeId: "7f2b8c4a-3e1d-4f6a-9b8c-2d7e5a1c3b9d",
      workflowId: "8f2b8c4a-3e1d-4f6a-9b8c-2d7e5a1c3b9d",
      triggerKind: WorkflowTriggerKind.Manual,
      triggerEventId: "manual:1",
    };
    expect(WorkflowRunStartJob.schema.safeParse({ ...base, hack: true }).success).toBe(false);
    expect(
      WorkflowRunStartJob.schema.safeParse({ ...base, subject: { customer: { email: "not-an-email" } } }).success,
    ).toBe(false);
  });

  it("send-batch requires a nullable cursor", () => {
    const base = {
      storeId: "7f2b8c4a-3e1d-4f6a-9b8c-2d7e5a1c3b9d",
      campaignId: "8f2b8c4a-3e1d-4f6a-9b8c-2d7e5a1c3b9d",
    };
    expect(CampaignSendBatchJob.schema.safeParse({ ...base, afterRecipientId: null }).success).toBe(true);
    expect(CampaignSendBatchJob.schema.safeParse(base).success).toBe(false);
  });
});
