import type { LegalDocument, LegalIdentity, LegalSection } from "./content/types";

/**
 * Legal page renderer (M7, ADR 25/26). Server-rendered, self-contained HTML:
 *   - escaping is EXHAUSTIVE and centralized (documents are typed data; the
 *     only interpolation path is escape-first);
 *   - zero external assets (inline CSS only) ⇒ CSP 'self' is never weakened,
 *     pages load instantly for review crawlers, and a CDN outage can never
 *     restyle a legal contract;
 *   - token substitution happens BEFORE escaping ⇒ config values are data,
 *     they can never inject markup.
 */

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function interpolate(text: string, identity: LegalIdentity): string {
  return text
    .replaceAll("{entity}", identity.entityName)
    .replaceAll("{supportEmail}", identity.supportEmail ?? "the in-app support center")
    .replaceAll("{appUrl}", identity.appUrl);
}

const PAGE_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0 16px 64px;
    font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1c2430; background: #f7f8fa;
  }
  .sheet { max-width: 760px; margin: 0 auto; }
  header.brand {
    display: flex; align-items: center; gap: 10px;
    padding: 28px 0 20px; border-bottom: 1px solid #e3e6eb; margin-bottom: 28px;
  }
  header.brand .mark {
    width: 26px; height: 26px; border-radius: 7px; background: #6D6AF8;
    color: #fff; font-weight: 800; font-size: 14px; display: grid; place-items: center;
  }
  header.brand .name { font-weight: 700; letter-spacing: 0.01em; color: #10151d; }
  header.brand nav { margin-left: auto; font-size: 13px; }
  header.brand nav a { color: #4b5a6d; text-decoration: none; margin-left: 14px; }
  header.brand nav a:hover { color: #6D6AF8; }
  h1 { font-size: 26px; line-height: 1.25; margin: 0 0 6px; color: #10151d; }
  .meta { color: #66738a; font-size: 13px; margin-bottom: 26px; }
  h2 { font-size: 17px; margin: 30px 0 8px; color: #10151d; }
  p { margin: 0 0 12px; }
  ul { margin: 0 0 12px; padding-left: 22px; }
  li { margin-bottom: 6px; }
  .cards { display: grid; gap: 12px; margin-top: 18px; }
  .cards a {
    display: block; background: #fff; border: 1px solid #e3e6eb; border-radius: 10px;
    padding: 14px 16px; text-decoration: none; color: inherit;
  }
  .cards a:hover { border-color: #6D6AF8; }
  .cards a .t { font-weight: 650; color: #10151d; }
  .cards a .s { color: #66738a; font-size: 13px; margin-top: 2px; }
  footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e3e6eb; color: #66738a; font-size: 12px; }
`;

function brandHeader(identity: LegalIdentity): string {
  return `<header class="brand">
  <span class="mark" aria-hidden="true">P</span>
  <span class="name">PROFIT TOOL AI</span>
  <nav><a href="/legal">Legal &amp; policies</a></nav>
</header>`;
}

function pageFrame(identity: LegalIdentity, title: string, bodyHtml: string): string {
  const year = new Date().getUTCFullYear();
  const contact =
    identity.supportEmail !== null
      ? `<a href="mailto:${escapeHtml(identity.supportEmail)}" style="color:#4b5a6d">${escapeHtml(identity.supportEmail)}</a>`
      : "the in-app support center";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — PROFIT TOOL AI</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="sheet">
${brandHeader(identity)}
${bodyHtml}
<footer>© ${String(year)} ${escapeHtml(identity.entityName)} · ${contact}</footer>
</div>
</body>
</html>`;
}

function renderSection(section: LegalSection, identity: LegalIdentity): string {
  const paragraph = (text: string): string => `<p>${escapeHtml(interpolate(text, identity))}</p>`;
  const parts: string[] = [`<h2>${escapeHtml(section.heading)}</h2>`];
  for (const text of section.paragraphs) parts.push(paragraph(text));
  if (section.list !== undefined) {
    parts.push("<ul>");
    for (const item of section.list) parts.push(`<li>${escapeHtml(interpolate(item, identity))}</li>`);
    parts.push("</ul>");
  }
  for (const text of section.paragraphsAfterList ?? []) parts.push(paragraph(text));
  return parts.join("\n");
}

export function renderLegalDocument(doc: LegalDocument, identity: LegalIdentity): string {
  const body = `<h1>${escapeHtml(doc.title)}</h1>
<p class="meta">Effective ${escapeHtml(doc.effectiveDate)} · version ${String(doc.version)}</p>
${doc.sections.map((section) => renderSection(section, identity)).join("\n")}`;
  return pageFrame(identity, doc.title, body);
}

export function renderLegalIndex(docs: readonly LegalDocument[], identity: LegalIdentity): string {
  const cards = docs
    .map(
      (doc) => `<a href="/legal/${escapeHtml(doc.slug)}">
  <div class="t">${escapeHtml(doc.title)}</div>
  <div class="s">${escapeHtml(doc.summary)}</div>
</a>`,
    )
    .join("\n");
  const body = `<h1>Legal &amp; policies</h1>
<p class="meta">The agreements and policies that govern PROFIT TOOL AI, effective for all merchants and users.</p>
<div class="cards">${cards}</div>`;
  return pageFrame(identity, "Legal & policies", body);
}
