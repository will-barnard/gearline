/**
 * Link removal for listing descriptions.
 *
 * Shopify's body_html is HTML, so "hyperlinked" copy arrives as
 * <a href="…">text</a>. Marketplaces either ban outbound links (eBay, Reverb) or
 * show them as dead text, so a listing can opt in to having them removed
 * (listing_overrides.strip_links — see listing-attribute-resolver).
 *
 * This runs at RESOLVE time, on whatever description is current, rather than
 * being baked into a saved copy. That is the point: a saved copy pins the text,
 * and a later edit in Shopify would stop reaching the listing.
 *
 * What counts as a link, and what happens to it:
 *   - <a href="…">some words</a>    → the anchor goes, "some words" stays
 *   - <a href="…">https://x.com</a> → removed entirely (the text *is* the link)
 *   - a bare http(s)://… or www.… in the text → removed
 *
 * Only text BETWEEN tags is scanned for bare URLs. Scanning the whole string
 * would also eat the src of an <img> and leave broken markup behind.
 *
 * The frontend keeps a copy of this logic (frontend/src/lib/stripLinks.js) for
 * the live link count in the listing editor. This file is the one that decides
 * what is actually sent; the two share a test table so they cannot drift quietly.
 */

const ANCHOR_RE = /<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi;
// Stray <a …> / </a> left behind by malformed markup (an unclosed anchor).
const STRAY_ANCHOR_TAG_RE = /<\/?a\b[^>]*>/gi;
const HAS_ANCHOR_TAG_RE = /<\/?a\b[^>]*>/i; // non-global: .test() on a /g regex is stateful
const URL_ONLY_RE = /^\s*(?:https?:\/\/|www\.)\S+\s*$/i;
const BARE_URL_RE = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
// Punctuation that ends a sentence rather than a URL: "see https://x.com/a." / "(https://x.com)".
const TRAILING_PUNCT_RE = /[.,;:!?)\]]+$/;

function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ');
}

/** Apply fn to the text between tags only, leaving every tag byte-for-byte intact. */
function mapTextSegments(html: string, fn: (segment: string) => string): string {
  return html
    .split(/(<[^>]*>)/)
    .map((part, i) => (i % 2 === 0 ? fn(part) : part))
    .join('');
}

function removeBareUrls(text: string): string {
  return text.replace(BARE_URL_RE, (match) => {
    const trailing = match.match(TRAILING_PUNCT_RE);
    return trailing ? trailing[0] : '';
  });
}

export function countLinks(text: string | null | undefined): number {
  if (!text) return 0;
  let anchors = 0;
  const withoutAnchors = text.replace(ANCHOR_RE, () => {
    anchors += 1;
    return '';
  });
  let bare = 0;
  mapTextSegments(withoutAnchors, (seg) => {
    bare += (seg.match(BARE_URL_RE) ?? []).length;
    return seg;
  });
  return anchors + bare;
}

/** The description with every link removed. Text with no links comes back unchanged. */
export function stripLinks(text: string): string {
  if (text === '') return text;
  if (countLinks(text) === 0 && !HAS_ANCHOR_TAG_RE.test(text)) return text;

  let out = text.replace(ANCHOR_RE, (_match, inner: string) => (URL_ONLY_RE.test(visibleText(inner)) ? '' : inner));
  out = out.replace(STRAY_ANCHOR_TAG_RE, '');
  out = mapTextSegments(out, removeBareUrls);

  // Tidy what removal leaves behind: "see )" → "see)", doubled spaces, empty <p></p>.
  out = mapTextSegments(out, (seg) => seg.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([.,;:!?)\]])/g, '$1'));
  return out
    .replace(/[ \t]+(<\/(?:p|li|div|h[1-6])>)/gi, '$1')
    .replace(/<(p|li|div|span)\b[^>]*>(?:\s|&nbsp;|<br\s*\/?>)*<\/\1>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
