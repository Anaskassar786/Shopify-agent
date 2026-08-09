import {
  and,
  desc,
  engagementEvents,
  eq,
  execRaw,
  gt,
  inArray,
  sql,
  stores,
  subscriptions,
} from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { EngagementEventKind, StoreStatus, SubscriptionStatus } from "@profit/types";
import type { TrialMailer } from "./ports";

/**
 * ChurnPreventionService (P11 retention): detects disengaged stores and sends
 * ONE education nudge per CHURN_NUDGE_COOLDOWN_DAYS — driven entirely by real
 * engagement_events + session activity, never by heuristics on invented data.
 *
 * M5 amendment (read-model only): "last activity" is the GREATEST of the
 * engagement stream and session activity (P11's "no logins" signal). Sessions
 * are written by auth, which must NEVER write into the growth event stream —
 * so the fold happens here at read time, not by polluting engagement_events.
 * The nudge names the store's latest real activity so the message is
 * value-first, not spam.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Silence window that qualifies a store as disengaged (P11 churn signals). */
export const CHURN_INACTIVITY_DAYS = 3;
export const CHURN_NUDGE_COOLDOWN_DAYS = 7;

export interface ChurnScanReport {
  readonly candidates: number;
  readonly nudged: readonly { storeId: string; to: string }[];
  readonly skippedNoMailer: number;
}

export class ChurnPreventionService {
  constructor(
    private readonly db: ProfitDb,
    private readonly mailer: TrialMailer | null,
    private readonly appUrl: string,
  ) {}

  async tick(now = new Date()): Promise<ChurnScanReport> {
    const inactivityCutoff = new Date(now.getTime() - CHURN_INACTIVITY_DAYS * DAY_MS);
    const cooldownCutoff = new Date(now.getTime() - CHURN_NUDGE_COOLDOWN_DAYS * DAY_MS);

    // Stores whose LAST observed activity — engagement OR session (logins,
    // token refreshes) — is older than the inactivity window. The fold is a
    // read-model union: auth never emits growth events, growth never reads
    // write-path secrets.
    const inactiveRaw = await execRaw<{ storeId: string; lastSeen: string | Date }>(this.db, sql`
      select s.id as "storeId", max(a.created_at) as "lastSeen"
      from stores s
      inner join (
        select store_id, created_at from engagement_events
        union all
        select store_id, created_at from sessions where store_id is not null
      ) a on a.store_id = s.id
      where s.status = ${StoreStatus.Active}
      group by s.id
      having max(a.created_at) < ${inactivityCutoff}
    `);
    // Raw driver rows return aggregates as strings on some drivers (PGlite) —
    // normalize at the edge to the Date the rest of the service reasons with.
    const inactive = inactiveRaw.map((row) => ({
      storeId: row.storeId,
      lastSeen: row.lastSeen instanceof Date ? row.lastSeen : new Date(row.lastSeen),
    }));

    const nudged: { storeId: string; to: string }[] = [];
    let skippedNoMailer = 0;

    for (const row of inactive) {
      // Cooldown: any nudge within the last 7 days mutes the next one.
      const recentNudge = await this.db
        .select({ id: engagementEvents.id })
        .from(engagementEvents)
        .where(
          and(
            eq(engagementEvents.storeId, row.storeId),
            inArray(engagementEvents.kind, [EngagementEventKind.ChurnNudgeSent]),
            gt(engagementEvents.createdAt, cooldownCutoff),
          ),
        )
        .limit(1);
      if (recentNudge[0] !== undefined) continue;

      const storeRows = await this.db
        .select({ name: stores.name, email: stores.email })
        .from(stores)
        .where(eq(stores.id, row.storeId))
        .limit(1);
      const store = storeRows[0];
      if (store === undefined || store.email === null || this.mailer === null) {
        skippedNoMailer += 1;
        continue;
      }

      // Only nudge paying/trialing stores — suspended/cancelled stores are a
      // billing conversation, not an education one.
      const subRows = await this.db
        .select({ status: subscriptions.status })
        .from(subscriptions)
        .where(eq(subscriptions.storeId, row.storeId))
        .limit(1);
      const subStatus = subRows[0]?.status ?? null;
      if (
        subStatus === SubscriptionStatus.Suspended ||
        subStatus === SubscriptionStatus.Cancelled ||
        subStatus === SubscriptionStatus.Expired
      ) {
        continue;
      }

      // Real open-opportunity count powers the education copy (P11 value-first).
      const lastMilestone = await this.db
        .select({ kind: engagementEvents.kind, createdAt: engagementEvents.createdAt })
        .from(engagementEvents)
        .where(eq(engagementEvents.storeId, row.storeId))
        .orderBy(desc(engagementEvents.createdAt))
        .limit(1);

      const silentDays = Math.floor((now.getTime() - row.lastSeen.getTime()) / DAY_MS);
      await this.mailer.send({
        to: store.email,
        shopName: store.name,
        subject: `${store.name}: your store hasn't been reviewed in ${String(silentDays)} days`,
        textBody: [
          `Hi ${store.name} team,`,
          "",
          `It's been ${String(silentDays)} days since anyone from your team opened PROFIT TOOL AI.`,
          `The engine kept analyzing in the background — your latest activity was "${lastMilestone[0]?.kind.toLowerCase().replaceAll("_", " ") ?? "store setup"}".`,
          "Open the app to review today's opportunities and keep the automation running for you.",
          "",
          `Open Profit Tool AI: ${this.appUrl}`,
          "",
          "— PROFIT TOOL AI",
        ].join("\n"),
        htmlBody: `<!doctype html><html><body style="margin:0;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0d1117;color:#e6edf3;">
          <div style="max-width:560px;margin:0 auto;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:28px;">
            <p style="margin:0 0 4px;font-size:12px;letter-spacing:0.12em;color:#7d8590;text-transform:uppercase;">Profit Tool AI · check-in</p>
            <h1 style="margin:0 0 12px;font-size:20px;color:#f0f6fc;">${store.name}: ${String(silentDays)} days since your last review</h1>
            <p style="font-size:14px;line-height:1.6;color:#c9d1d9;">The engine kept analyzing in the background. Open the app to see today's opportunities — the automation you approved keeps running, but nothing replaces a quick weekly review.</p>
            <a href="${this.appUrl}" style="display:inline-block;margin-top:16px;background:#2f81f7;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 20px;border-radius:8px;">Open Profit Tool AI</a>
            <p style="margin:24px 0 0;font-size:12px;color:#7d8590;">You received this because your store installed PROFIT TOOL AI.</p>
          </div></body></html>`,
      });
      await this.db.insert(engagementEvents).values({
        storeId: row.storeId,
        kind: EngagementEventKind.ChurnNudgeSent,
        metadata: { silentDays, lastSeen: row.lastSeen.toISOString() },
      });
      nudged.push({ storeId: row.storeId, to: store.email });
    }

    return { candidates: inactive.length, nudged, skippedNoMailer };
  }
}
