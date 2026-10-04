// Small, dependency-free helpers for pulling values out of server-rendered
// storefront HTML. Adapters target specific, known markup, so targeted
// extraction is enough and avoids shipping a DOM parser into the Worker.

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  hellip: '...',
  trade: '(TM)',
  reg: '(R)',
  copy: '(C)',
  deg: ' deg',
  frac12: '1/2',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Visible text of an HTML fragment, keeping paragraph and line breaks. */
export function htmlToText(fragment: string): string {
  const text = fragment
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .split('\n')
    .map((line) => collapseWhitespace(line))
    .filter((line, i, all) => line !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .trim();
}

/** Value of an attribute on the first tag matching `tagPattern`. */
export function attrOf(tag: string, attr: string): string | null {
  const m = new RegExp(`\\s${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (!m) return null;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '');
}

/** All opening tags of `name` that carry `attr="value"` (exact match). */
export function tagsWithAttr(html: string, name: string, attr: string, value: string): string[] {
  const re = new RegExp(`<${name}\\b[^>]*>`, 'gi');
  const out: string[] = [];
  for (const m of html.matchAll(re)) {
    if (attrOf(m[0], attr) === value) out.push(m[0]);
  }
  return out;
}

/**
 * Inner HTML of the first element with `id`, up to its matching close tag.
 * Counts nested tags of the same name, so nested divs are handled.
 */
export function innerHtmlById(html: string, id: string): string | null {
  const open = new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*\\sid\\s*=\\s*["']${escapeRegExp(id)}["'][^>]*>`, 'i').exec(html);
  if (!open || open[1] === undefined) return null;
  const name = open[1].toLowerCase();
  const start = open.index + open[0].length;
  const tagRe = new RegExp(`<(/?)${name}\\b[^>]*>`, 'gi');
  tagRe.lastIndex = start;
  let depth = 1;
  for (let m = tagRe.exec(html); m; m = tagRe.exec(html)) {
    depth += m[1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index);
  }
  return html.slice(start);
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Resolves a possibly relative URL against a base; null when it can't be parsed. */
export function absoluteUrl(href: string, base: string): string | null {
  try {
    return new URL(decodeEntities(href.trim()), base).toString();
  } catch {
    return null;
  }
}

/** "$1,234.50" -> "1234.50"; null when no number is present. */
export function parsePrice(raw: string): string | null {
  const m = /(\d[\d,]*(?:\.\d+)?)/.exec(raw.replace(/\s/g, ''));
  if (!m || m[1] === undefined) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 ? n.toFixed(2) : null;
}

/** Contents of every <script type="application/ld+json"> block. */
export function jsonLdBlocks(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const type = attrOf(m[0].slice(0, m[0].indexOf('>') + 1), 'type');
    if (type?.toLowerCase() === 'application/ld+json' && m[2] !== undefined) out.push(m[2].trim());
  }
  return out;
}
