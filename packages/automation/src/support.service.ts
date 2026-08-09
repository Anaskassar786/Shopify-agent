import {
  and,
  asc,
  count,
  desc,
  eq,
  sql,
  withStoreScope,
  stores,
  supportTicketMessages,
  supportTickets,
  users,
} from "@profit/db";
import type { ProfitDb } from "@profit/db";
import {
  SupportTicketPriority,
  SupportTicketStatus,
  TicketAuthorKind,
  type SupportTicketCategory as SupportTicketCategoryType,
  type SupportTicketPriority as SupportTicketPriorityType,
  type SupportTicketStatus as SupportTicketStatusType,
  type TicketAuthorKind as TicketAuthorKindType,
} from "@profit/types";

/**
 * SupportService (M6): merchant↔operator ticket threads. Merchant methods
 * are tenant-scoped; the operator (platform admin) methods run cross-tenant
 * through the owner role (the admin module authenticates operators with the
 * step-up session; every operator mutation is ledgered by the caller into
 * platform_admin_actions).
 */

export class TicketNotFoundError extends Error {
  constructor(id: string) {
    super(`support ticket ${id} not found`);
    this.name = "TicketNotFoundError";
  }
}

export class TicketStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketStateError";
  }
}

export interface TicketRow {
  readonly id: string;
  readonly openedByUserId: string | null;
  readonly subject: string;
  readonly category: SupportTicketCategoryType;
  readonly priority: SupportTicketPriorityType;
  readonly status: SupportTicketStatusType;
  readonly messageCount: number;
  readonly lastMessageAt: Date | null;
  readonly assignedOperator: string | null;
  readonly operatorAttention: boolean;
  readonly resolvedAt: Date | null;
  readonly closedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TicketMessageRow {
  readonly id: string;
  readonly authorKind: TicketAuthorKindType;
  readonly authorUserId: string | null;
  readonly authorOperator: string | null;
  readonly authorEmail: string | null;
  readonly body: string;
  readonly createdAt: Date;
}

export interface AdminTicketRow extends TicketRow {
  readonly shopDomain: string;
  readonly storeName: string;
  readonly openerEmail: string | null;
}

export const TICKET_LIMITS = {
  subjectMax: 200,
  bodyMax: 10_000,
  pageSizeMax: 50,
} as const;

export class SupportService {
  constructor(private readonly db: ProfitDb) {}

  /* ─── merchant side (tenant-scoped) ─────────────────────────────── */

  async createTicket(
    storeId: string,
    input: {
      openedByUserId: string;
      subject: string;
      category: SupportTicketCategoryType;
      priority?: SupportTicketPriorityType;
      body: string;
    },
    now = new Date(),
  ): Promise<TicketRow> {
    this.assertValid(input.subject, input.body);
    if (input.priority !== undefined && !Object.values(SupportTicketPriority).includes(input.priority)) {
      throw new TicketStateError("invalid priority");
    }
    return withStoreScope(this.db, storeId, async (tx) => {
      const inserted = await tx
        .insert(supportTickets)
        .values({
          storeId,
          openedByUserId: input.openedByUserId,
          subject: input.subject,
          category: input.category,
          priority: input.priority ?? SupportTicketPriority.Normal,
          status: SupportTicketStatus.Open,
          messageCount: 1,
          lastMessageAt: now,
          operatorAttention: true,
        })
        .returning();
      const ticket = inserted[0];
      if (ticket === undefined) throw new TicketStateError("ticket insert returned no row");
      await tx.insert(supportTicketMessages).values({
        storeId,
        ticketId: ticket.id,
        authorKind: TicketAuthorKind.Merchant,
        authorUserId: input.openedByUserId,
        body: input.body,
      });
      return this.toRow(ticket);
    });
  }

  async listTickets(
    storeId: string,
    page: number,
    pageSize: number,
  ): Promise<{ readonly rows: readonly TicketRow[]; readonly total: number }> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select()
        .from(supportTickets)
        .where(eq(supportTickets.storeId, storeId))
        .orderBy(desc(supportTickets.lastMessageAt))
        .limit(Math.min(pageSize, TICKET_LIMITS.pageSizeMax))
        .offset((page - 1) * Math.min(pageSize, TICKET_LIMITS.pageSizeMax));
      const totals = await tx
        .select({ total: count() })
        .from(supportTickets)
        .where(eq(supportTickets.storeId, storeId));
      return { rows: rows.map((r) => this.toRow(r)), total: totals[0]?.total ?? 0 };
    });
  }

  async getTicket(
    storeId: string,
    ticketId: string,
  ): Promise<{ readonly ticket: TicketRow; readonly messages: readonly TicketMessageRow[] } | null> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select()
        .from(supportTickets)
        .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.storeId, storeId)))
        .limit(1);
      const ticket = rows[0];
      if (ticket === undefined) return null;
      const messages = await tx
        .select({
          id: supportTicketMessages.id,
          authorKind: supportTicketMessages.authorKind,
          authorUserId: supportTicketMessages.authorUserId,
          authorOperator: supportTicketMessages.authorOperator,
          authorEmail: users.email,
          body: supportTicketMessages.body,
          createdAt: supportTicketMessages.createdAt,
        })
        .from(supportTicketMessages)
        .leftJoin(users, eq(supportTicketMessages.authorUserId, users.id))
        .where(eq(supportTicketMessages.ticketId, ticketId))
        .orderBy(asc(supportTicketMessages.createdAt));
      return { ticket: this.toRow(ticket), messages };
    });
  }

  /**
   * Merchant reply. RESOLVED reopens to OPEN (the customer disagrees);
   * CLOSED is terminal — raise a new ticket.
   */
  async replyAsMerchant(
    storeId: string,
    ticketId: string,
    userId: string,
    body: string,
    now = new Date(),
  ): Promise<{ readonly ticket: TicketRow; readonly messageId: string }> {
    this.assertBody(body);
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select()
        .from(supportTickets)
        .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.storeId, storeId)))
        .limit(1);
      const ticket = rows[0];
      if (ticket === undefined) throw new TicketNotFoundError(ticketId);
      if (ticket.status === SupportTicketStatus.Closed) {
        throw new TicketStateError("closed tickets cannot be replied to — open a new ticket");
      }
      const inserted = await tx
        .insert(supportTicketMessages)
        .values({
          storeId,
          ticketId,
          authorKind: TicketAuthorKind.Merchant,
          authorUserId: userId,
          body,
        })
        .returning({ id: supportTicketMessages.id });
      const reopen = ticket.status === SupportTicketStatus.Resolved || ticket.status === SupportTicketStatus.WaitingOnCustomer;
      const updated = await tx
        .update(supportTickets)
        .set({
          status: reopen ? SupportTicketStatus.Open : ticket.status,
          messageCount: sql`${supportTickets.messageCount} + 1`,
          lastMessageAt: now,
          operatorAttention: true,
          resolvedAt: reopen ? null : ticket.resolvedAt,
          updatedAt: now,
        })
        .where(eq(supportTickets.id, ticketId))
        .returning();
      const row = updated[0];
      if (row === undefined) throw new TicketNotFoundError(ticketId);
      return { ticket: this.toRow(row), messageId: inserted[0]!.id };
    });
  }

  async closeByMerchant(storeId: string, ticketId: string, now = new Date()): Promise<TicketRow> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const updated = await tx
        .update(supportTickets)
        .set({ status: SupportTicketStatus.Closed, closedAt: now, operatorAttention: false, updatedAt: now })
        .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.storeId, storeId)))
        .returning();
      const row = updated[0];
      if (row === undefined) throw new TicketNotFoundError(ticketId);
      return this.toRow(row);
    });
  }

  /* ─── operator side (owner role — admin module only) ────────────── */

  async listForOperators(input: {
    attentionOnly: boolean;
    status?: SupportTicketStatusType;
    page: number;
    pageSize: number;
  }): Promise<{ readonly rows: readonly AdminTicketRow[]; readonly total: number }> {
    const conditions = [];
    if (input.attentionOnly) conditions.push(eq(supportTickets.operatorAttention, true));
    if (input.status !== undefined) conditions.push(eq(supportTickets.status, input.status));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const rows = await this.db
      .select({
        ticket: supportTickets,
        shopDomain: stores.shopDomain,
        storeName: stores.name,
        openerEmail: users.email,
      })
      .from(supportTickets)
      .innerJoin(stores, eq(supportTickets.storeId, stores.id))
      .leftJoin(users, eq(supportTickets.openedByUserId, users.id))
      .where(where)
      .orderBy(desc(supportTickets.lastMessageAt))
      .limit(Math.min(input.pageSize, TICKET_LIMITS.pageSizeMax))
      .offset((input.page - 1) * Math.min(input.pageSize, TICKET_LIMITS.pageSizeMax));
    const totals = await this.db.select({ total: count() }).from(supportTickets).where(where);
    return {
      rows: rows.map((r) => ({ ...this.toRow(r.ticket), shopDomain: r.shopDomain, storeName: r.storeName, openerEmail: r.openerEmail })),
      total: totals[0]?.total ?? 0,
    };
  }

  async getForOperator(
    ticketId: string,
  ): Promise<{
    readonly ticket: AdminTicketRow;
    readonly messages: readonly TicketMessageRow[];
  } | null> {
    const rows = await this.db
      .select({
        ticket: supportTickets,
        shopDomain: stores.shopDomain,
        storeName: stores.name,
        openerEmail: users.email,
      })
      .from(supportTickets)
      .innerJoin(stores, eq(supportTickets.storeId, stores.id))
      .leftJoin(users, eq(supportTickets.openedByUserId, users.id))
      .where(eq(supportTickets.id, ticketId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    const messages = await this.db
      .select({
        id: supportTicketMessages.id,
        authorKind: supportTicketMessages.authorKind,
        authorUserId: supportTicketMessages.authorUserId,
        authorOperator: supportTicketMessages.authorOperator,
        authorEmail: users.email,
        body: supportTicketMessages.body,
        createdAt: supportTicketMessages.createdAt,
      })
      .from(supportTicketMessages)
      .leftJoin(users, eq(supportTicketMessages.authorUserId, users.id))
      .where(eq(supportTicketMessages.ticketId, ticketId))
      .orderBy(asc(supportTicketMessages.createdAt));
    return {
      ticket: { ...this.toRow(row.ticket), shopDomain: row.shopDomain, storeName: row.storeName, openerEmail: row.openerEmail },
      messages: messages as readonly TicketMessageRow[],
    };
  }

  /** Operator reply → WAITING_ON_CUSTOMER; the notify job emails the merchant. */
  async replyAsOperator(
    ticketId: string,
    operator: string,
    body: string,
    now = new Date(),
  ): Promise<{ readonly ticket: AdminTicketRow; readonly messageId: string }> {
    this.assertBody(body);
    const rows = await this.db.select().from(supportTickets).where(eq(supportTickets.id, ticketId)).limit(1);
    const ticket = rows[0];
    if (ticket === undefined) throw new TicketNotFoundError(ticketId);
    if (ticket.status === SupportTicketStatus.Closed) {
      throw new TicketStateError("closed tickets cannot be replied to");
    }
    const inserted = await this.db
      .insert(supportTicketMessages)
      .values({
        storeId: ticket.storeId,
        ticketId,
        authorKind: TicketAuthorKind.Operator,
        authorOperator: operator,
        body,
      })
      .returning({ id: supportTicketMessages.id });
    await this.db
      .update(supportTickets)
      .set({
        status: SupportTicketStatus.WaitingOnCustomer,
        messageCount: sql`${supportTickets.messageCount} + 1`,
        lastMessageAt: now,
        assignedOperator: operator,
        operatorAttention: false,
        updatedAt: now,
      })
      .where(eq(supportTickets.id, ticketId));
    const refreshed = await this.getForOperator(ticketId);
    if (refreshed === null) throw new TicketNotFoundError(ticketId);
    return { ticket: refreshed.ticket, messageId: inserted[0]!.id };
  }

  async operatorTransition(
    ticketId: string,
    target: typeof SupportTicketStatus.Resolved | typeof SupportTicketStatus.Closed,
    now = new Date(),
  ): Promise<AdminTicketRow> {
    const patch =
      target === SupportTicketStatus.Resolved
        ? { status: SupportTicketStatus.Resolved, resolvedAt: now, operatorAttention: false, updatedAt: now }
        : { status: SupportTicketStatus.Closed, closedAt: now, operatorAttention: false, updatedAt: now };
    const updated = await this.db
      .update(supportTickets)
      .set(patch)
      .where(eq(supportTickets.id, ticketId))
      .returning({ id: supportTickets.id });
    if (updated.length === 0) throw new TicketNotFoundError(ticketId);
    const refreshed = await this.getForOperator(ticketId);
    if (refreshed === null) throw new TicketNotFoundError(ticketId);
    return refreshed.ticket;
  }

  /** Merchant-facing lookup for the notify job (opener email + thread). */
  async loadNotifyContext(
    ticketId: string,
    messageId: string,
  ): Promise<{
    readonly storeId: string;
    readonly subject: string;
    readonly openerEmail: string | null;
    readonly operator: string | null;
    readonly body: string;
    readonly shopDomain: string;
  } | null> {
    const tickets = await this.db
      .select({ storeId: supportTickets.storeId, subject: supportTickets.subject, openedByUserId: supportTickets.openedByUserId, shopDomain: stores.shopDomain })
      .from(supportTickets)
      .innerJoin(stores, eq(supportTickets.storeId, stores.id))
      .where(eq(supportTickets.id, ticketId))
      .limit(1);
    const ticket = tickets[0];
    if (ticket === undefined) return null;
    const messages = await this.db
      .select({ body: supportTicketMessages.body, authorOperator: supportTicketMessages.authorOperator, authorKind: supportTicketMessages.authorKind })
      .from(supportTicketMessages)
      .where(eq(supportTicketMessages.id, messageId))
      .limit(1);
    const message = messages[0];
    if (message === undefined || message.authorKind !== TicketAuthorKind.Operator) return null;
    let openerEmail: string | null = null;
    if (ticket.openedByUserId !== null) {
      const userRows = await this.db.select({ email: users.email }).from(users).where(eq(users.id, ticket.openedByUserId)).limit(1);
      openerEmail = userRows[0]?.email ?? null;
    }
    return {
      storeId: ticket.storeId,
      subject: ticket.subject,
      openerEmail,
      operator: message.authorOperator,
      body: message.body,
      shopDomain: ticket.shopDomain,
    };
  }

  private assertValid(subject: string, body: string): void {
    if (subject.trim().length === 0 || subject.length > TICKET_LIMITS.subjectMax) {
      throw new TicketStateError("subject must be 1..200 characters");
    }
    this.assertBody(body);
  }

  private assertBody(body: string): void {
    if (body.trim().length === 0 || body.length > TICKET_LIMITS.bodyMax) {
      throw new TicketStateError("message body must be 1..10000 characters");
    }
  }

  private toRow(row: typeof supportTickets.$inferSelect): TicketRow {
    const { storeId: _storeId, ...rest } = row;
    return rest;
  }
}
