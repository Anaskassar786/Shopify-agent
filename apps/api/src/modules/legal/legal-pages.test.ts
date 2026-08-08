import { describe, expect, it } from "vitest";
import { LEGAL_DOCUMENTS } from "./content";
import { escapeHtml, renderLegalDocument, renderLegalIndex } from "./legal-pages";
import type { LegalDocument, LegalIdentity } from "./content/types";

/**
 * Legal renderer (M7) — escaping authority, token substitution, and the
 * content-integrity invariants of the published document set.
 */

const IDENTITY: LegalIdentity = {
  entityName: "Profit Tool AI Test Labs",
  supportEmail: "support@profittest.invalid",
  appUrl: "https://app.profit.test",
};

describe("escapeHtml", () => {
  it("escapes the full HTML metacharacter set", () => {
    expect(escapeHtml(`<script>"x"&'y'</script>`)).toBe("&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;");
  });
});

describe("document rendering", () => {
  it("interpolates identity tokens BEFORE escaping: config values cannot inject markup", () => {
    const hostileDoc: LegalDocument = {
      slug: "x",
      title: "T <img>",
      effectiveDate: "2026-01-01",
      version: 1,
      summary: "s",
      sections: [
        {
          heading: "1. H",
          paragraphs: ["Contact {supportEmail}; party {entity}; home {appUrl}."],
          list: ["item <b>one</b>"],
        },
      ],
    };
    const html = renderLegalDocument(hostileDoc, {
      ...IDENTITY,
      entityName: 'Evil <script>alert(1)</script> "Co"',
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("Evil &lt;script&gt;alert(1)&lt;/script&gt; &quot;Co&quot;");
    expect(html).toContain("support@profittest.invalid");
    expect(html).toContain("https://app.profit.test");
    expect(html).toContain("item &lt;b&gt;one&lt;/b&gt;");
    expect(html).toContain("T &lt;img&gt;");
  });

  it("falls back to the in-app support center when no support email is configured", () => {
    const doc = LEGAL_DOCUMENTS[0];
    expect(doc).toBeDefined();
    const html = renderLegalDocument(doc!, { ...IDENTITY, supportEmail: null });
    expect(html).toContain("the in-app support center");
    expect(html).not.toContain("mailto:");
  });

  it("renders every published document end-to-end without unresolved tokens", () => {
    for (const doc of LEGAL_DOCUMENTS) {
      const html = renderLegalDocument(doc, IDENTITY);
      expect(html).toContain(`<h1>${doc.title}</h1>`);
      expect(html).toContain(`Effective ${doc.effectiveDate}`);
      expect(html).not.toMatch(/\{(entity|supportEmail|appUrl)\}/);
    }
  });

  it("index lists every published document with its summary and stable URL", () => {
    const html = renderLegalIndex(LEGAL_DOCUMENTS, IDENTITY);
    expect(html).toContain("Legal &amp; policies");
    for (const doc of LEGAL_DOCUMENTS) {
      expect(html).toContain(`/legal/${doc.slug}`);
      expect(html).toContain(doc.summary);
    }
  });
});

describe("published content invariants", () => {
  const ALLOWED_TOKENS = new Set(["{entity}", "{supportEmail}", "{appUrl}"]);
  const allText = (doc: LegalDocument): string =>
    [
      doc.title,
      doc.summary,
      ...doc.sections.flatMap((s) => [...s.paragraphs, ...(s.list ?? []), ...(s.paragraphsAfterList ?? []), s.heading]),
    ].join("\n");

  it("documents are complete: slug, date, version, ≥5 substantive sections", () => {
    const slugs = new Set<string>();
    for (const doc of LEGAL_DOCUMENTS) {
      expect(doc.slug).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(slugs.has(doc.slug)).toBe(false);
      slugs.add(doc.slug);
      expect(doc.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(doc.version).toBeGreaterThanOrEqual(1);
      expect(doc.sections.length).toBeGreaterThanOrEqual(5);
      for (const section of doc.sections) {
        expect(section.paragraphs.length + (section.list?.length ?? 0)).toBeGreaterThan(0);
        expect(section.heading.length).toBeGreaterThan(4);
      }
    }
  });

  it("only sanctioned tokens appear in prose", () => {
    for (const doc of LEGAL_DOCUMENTS) {
      const tokens = allText(doc).match(/\{[a-zA-Z]+\}/g) ?? [];
      for (const token of tokens) expect(ALLOWED_TOKENS.has(token)).toBe(true);
    }
  });

  it("no external URLs leak into policies (pages must stay self-contained)", () => {
    for (const doc of LEGAL_DOCUMENTS) {
      // The only URL-shaped token allowed is {appUrl}, substituted at render.
      expect(allText(doc)).not.toMatch(/https?:\/\//);
    }
  });

  it("the mandated P7 set is published: privacy, terms, refunds, acceptable use, security", () => {
    const slugs = LEGAL_DOCUMENTS.map((doc) => doc.slug);
    expect(slugs).toEqual(["privacy", "terms", "refunds", "acceptable-use", "security"]);
  });
});
