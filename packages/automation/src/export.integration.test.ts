import { auditLogs, exportsTable, eq, shopifyOrders, shopifyProducts } from "@profit/db";
import type { TestDatabase } from "@profit/db/testing";
import { AuditResult, ExportFormat, ExportKind, ExportStatus, ExportStatus as Status, ProductStatus } from "@profit/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootAutomationTestDb, seedAutomationStore, seedCustomer, seedUser, uniqueDomain } from "./test-support/integration";
import { ExportService, ExportStateError, mimeForFormat } from "./export.service";

/**
 * ExportService contract: request → generate → download lifecycle, all five
 * report kinds against the real replica tables, all three formats' magic
 * bytes, expiry sweep, and tenant scoping.
 */

let testDb: TestDatabase;
let service: ExportService;
let storeId = "";
let userId = "";

beforeAll(async () => {
  testDb = await bootAutomationTestDb();
  service = new ExportService(testDb.db);
  storeId = await seedAutomationStore(testDb.db, { shopDomain: uniqueDomain("export") });
  userId = await seedUser(testDb.db, { email: "exporter@example.com" });

  await seedCustomer(testDb.db, {
    storeId,
    email: "ada@example.com",
    firstName: "Ada",
    lastName: "L",
    ordersCount: 3,
    totalSpent: "120.50",
    acceptsMarketing: true,
    tags: ["vip"],
  });

  await testDb.db.insert(shopifyOrders).values({
    storeId,
    shopifyOrderId: "o-1",
    name: "#1001",
    email: "ada@example.com",
    financialStatus: "paid",
    currency: "USD",
    totalPrice: "42.00",
    processedAt: new Date("2026-08-02T10:00:00Z"),
  });

  await testDb.db.insert(shopifyProducts).values({
    storeId,
    shopifyProductId: "p-1",
    title: "Runner Sneaker",
    handle: "runner-sneaker",
    status: ProductStatus.Active,
    vendor: "Acme",
  });

  await testDb.db.insert(auditLogs).values({
    storeId,
    userId,
    action: "store.updated",
    entityType: "store",
    entityId: storeId,
    result: AuditResult.Success,
    ip: "203.0.113.5",
  });
});

afterAll(async () => {
  await testDb.close();
});

describe("request → generate → download (csv)", () => {
  it("customers csv lifecycle with real rows", async () => {
    const requested = await service.request(storeId, {
      kind: ExportKind.Customers,
      format: ExportFormat.Csv,
      requestedByUserId: userId,
    });
    expect(requested.status).toBe(ExportStatus.Queued);

    const generated = await service.generate(storeId, requested.id);
    expect(generated.generated).toBe(true);

    const listed = await service.list(storeId, 1, 10);
    const row = listed.rows.find((r) => r.id === requested.id);
    expect(row?.status).toBe(Status.Ready);
    expect(row?.rowCount).toBe(1);
    expect(row?.fileName).toMatch(/^profit-tool-customers-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(row?.expiresAt).not.toBeNull();

    // Detail lookup used by the notify path + API download preflight.
    const fetched = await service.getExport(storeId, requested.id);
    expect(fetched?.id).toBe(requested.id);
    expect(await service.getExport(storeId, crypto.randomUUID())).toBeNull();
    const foreign = await seedAutomationStore(testDb.db, { shopDomain: uniqueDomain("export-foreign") });
    expect(await service.getExport(foreign, requested.id)).toBeNull();

    const file = await service.loadFile(storeId, requested.id);
    expect(file.mime).toBe("text/csv; charset=utf-8");
    const text = file.data.toString("utf8");
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain("Email,First Name,Last Name");
    expect(text).toContain("ada@example.com,Ada,L");
    expect(text).toContain("vip");
  });

  it("audit logs export with date filters and actor join", async () => {
    const requested = await service.request(storeId, {
      kind: ExportKind.AuditLogs,
      format: ExportFormat.Csv,
      requestedByUserId: userId,
      params: { from: "2026-08-01T00:00:00Z", to: "2027-01-01T00:00:00Z" },
    });
    await service.generate(storeId, requested.id);
    const file = await service.loadFile(storeId, requested.id);
    const text = file.data.toString("utf8");
    expect(text).toContain("store.updated");
    expect(text).toContain("exporter@example.com");
    expect(text).toContain("203.0.113.5");

    // A window excluding the audit row yields the header only.
    const empty = await service.request(storeId, {
      kind: ExportKind.AuditLogs,
      format: ExportFormat.Csv,
      requestedByUserId: userId,
      params: { from: "2020-01-01T00:00:00Z", to: "2020-01-02T00:00:00Z" },
    });
    await service.generate(storeId, empty.id);
    const emptyFile = await service.loadFile(storeId, empty.id);
    expect(emptyFile.data.toString("utf8").split("\r\n")).toHaveLength(2); // header + trailing CRLF
  });

  it("rejects inverted date windows at request time", async () => {
    await expect(
      service.request(storeId, {
        kind: ExportKind.AuditLogs,
        format: ExportFormat.Csv,
        requestedByUserId: userId,
        params: { from: "2026-08-10T00:00:00Z", to: "2026-08-01T00:00:00Z" },
      }),
    ).rejects.toBeInstanceOf(ExportStateError);
  });
});

describe("formats", () => {
  it("xlsx: valid zip container with the sheet part", async () => {
    const requested = await service.request(storeId, {
      kind: ExportKind.Orders,
      format: ExportFormat.Xlsx,
      requestedByUserId: userId,
    });
    await service.generate(storeId, requested.id);
    const file = await service.loadFile(storeId, requested.id);
    expect(file.mime).toContain("spreadsheetml");
    expect(file.data.readUInt32LE(0)).toBe(0x04034b50); // PK zip
    expect(file.fileName).toContain(".xlsx");
    expect(file.data.toString("latin1")).toContain("xl/worksheets/sheet1.xml");
    expect(file.data.toString("utf8")).toContain("#1001");
  });

  it("pdf: valid document with xref + table content", async () => {
    const requested = await service.request(storeId, {
      kind: ExportKind.Products,
      format: ExportFormat.Pdf,
      requestedByUserId: userId,
    });
    await service.generate(storeId, requested.id);
    const file = await service.loadFile(storeId, requested.id);
    expect(file.mime).toBe("application/pdf");
    expect(file.data.slice(0, 8).toString("latin1")).toBe("%PDF-1.4");
    expect(file.data.toString("latin1")).toContain("(Runner");
    expect(file.data.toString("latin1")).toContain("(Title)");
    expect(file.data.toString("latin1")).toContain("startxref");
  });

  it("mime map covers every format", () => {
    expect(mimeForFormat(ExportFormat.Csv)).toContain("csv");
    expect(mimeForFormat(ExportFormat.Xlsx)).toContain("spreadsheetml");
    expect(mimeForFormat(ExportFormat.Pdf)).toContain("pdf");
  });
});

describe("guards", () => {
  it("double-generate is a CAS no-op", async () => {
    const requested = await service.request(storeId, {
      kind: ExportKind.Products,
      format: ExportFormat.Csv,
      requestedByUserId: userId,
    });
    expect((await service.generate(storeId, requested.id)).generated).toBe(true);
    expect((await service.generate(storeId, requested.id)).generated).toBe(false);
  });

  it("concurrent-export cap refuses the sixth request", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await service.request(storeId, {
        kind: ExportKind.Products,
        format: ExportFormat.Csv,
        requestedByUserId: userId,
      });
      ids.push(r.id);
    }
    await expect(
      service.request(storeId, {
        kind: ExportKind.Products,
        format: ExportFormat.Csv,
        requestedByUserId: userId,
      }),
    ).rejects.toBeInstanceOf(ExportStateError);
    for (const id of ids) await service.generate(storeId, id);
  });

  it("recommendations export exists and renders 0 rows honestly for untouched stores", async () => {
    const requested = await service.request(storeId, {
      kind: ExportKind.Recommendations,
      format: ExportFormat.Csv,
      requestedByUserId: userId,
    });
    await service.generate(storeId, requested.id);
    const file = await service.loadFile(storeId, requested.id);
    expect(file.data.toString("utf8")).toContain("Type,Title,Status");
  });

  it("tenant B sees none of tenant A's exports (RLS)", async () => {
    const other = await seedAutomationStore(testDb.db, { shopDomain: uniqueDomain("export-b") });
    const listed = await service.list(other, 1, 10);
    expect(listed.rows).toHaveLength(0);
    await expect(service.loadFile(other, "00000000-0000-0000-0000-000000000000")).rejects.toThrow();
  });
});

describe("expiry", () => {
  it("sweepExpired nulls bytes beyond retention; downloads then refuse", async () => {
    const requested = await service.request(storeId, {
      kind: ExportKind.Customers,
      format: ExportFormat.Csv,
      requestedByUserId: userId,
    });
    await service.generate(storeId, requested.id);
    const swept = await service.sweepExpired(new Date(Date.now() + 8 * 86_400_000));
    expect(swept).toBeGreaterThanOrEqual(1);
    const rows = await testDb.db
      .select({ fileData: exportsTable.fileData, status: exportsTable.status })
      .from(exportsTable)
      .where(eq(exportsTable.id, requested.id));
    expect(rows[0]?.status).toBe(ExportStatus.Ready);
    expect(rows[0]?.fileData).toBeNull();
    await expect(service.loadFile(storeId, requested.id)).rejects.toThrow(/expired/);
  });
});
