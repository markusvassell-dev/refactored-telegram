/**
 * Minimal, dependency-free OOXML helpers.
 *
 * We deliberately do not round-trip WordprocessingML through a generic XML
 * DOM. Re-serialising Word's XML is the classic way to lose formatting,
 * numbering, headers, footers and content controls. Instead we perform
 * surgical, well-understood string operations on the original markup so that
 * everything we do not touch is preserved byte-for-byte.
 */

export const XML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => XML_ENTITIES[character] ?? character);
}

export function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

export interface XmlBlock {
  /** Qualified tag name, e.g. `w:p`, `w:tbl`, `w:sectPr`. */
  tag: string;
  /** The complete markup for this element, including its tags. */
  xml: string;
  /** Offset of this block within the string it was extracted from. */
  start: number;
  end: number;
}

const TAG_START = /<(\/?)([A-Za-z_][\w.-]*(?::[\w.-]+)?)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

/**
 * Splits a fragment into its top-level elements, correctly handling elements
 * of the same name nested inside one another (e.g. `w:tbl` inside `w:tc`).
 * Text between elements is ignored — WordprocessingML bodies contain none.
 */
export function splitTopLevelBlocks(fragment: string): XmlBlock[] {
  const blocks: XmlBlock[] = [];
  const pattern = new RegExp(TAG_START.source, 'g');

  let depth = 0;
  let currentTag: string | null = null;
  let blockStart = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(fragment)) !== null) {
    const [raw, closing, tag, , selfClosing] = match as unknown as [string, string, string, string, string];
    const isClosing = closing === '/';
    const isSelfClosing = selfClosing === '/';

    if (depth === 0) {
      if (isClosing) continue; // Stray close tag; nothing sensible to do.
      if (isSelfClosing) {
        blocks.push({ tag, xml: raw, start: match.index, end: match.index + raw.length });
        continue;
      }
      currentTag = tag;
      blockStart = match.index;
      depth = 1;
      continue;
    }

    if (tag !== currentTag || isSelfClosing) continue;

    if (isClosing) {
      depth -= 1;
      if (depth === 0 && currentTag) {
        const end = match.index + raw.length;
        blocks.push({ tag: currentTag, xml: fragment.slice(blockStart, end), start: blockStart, end });
        currentTag = null;
      }
    } else {
      depth += 1;
    }
  }

  return blocks;
}

/**
 * Returns the inner XML of the first `<tag>...</tag>` in `xml`, or null.
 *
 * Intended for container elements that never nest inside themselves —
 * `w:body`, `w:hdr`, `w:ftr`. Do not use it for `w:tbl` or `w:p`.
 */
export function innerXml(xml: string, tag: string): { inner: string; start: number; end: number } | null {
  const openMatch = new RegExp(`<${tag}(?:\\s[^>]*)?>`).exec(xml);
  if (!openMatch) return null;

  const contentStart = openMatch.index + openMatch[0].length;
  const contentEnd = xml.lastIndexOf(`</${tag}>`);
  if (contentEnd < contentStart) return null;

  return { inner: xml.slice(contentStart, contentEnd), start: contentStart, end: contentEnd };
}

/** Concatenated visible text of a WordprocessingML fragment. */
export function blockText(xml: string): string {
  let text = '';
  const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    if (match[1] !== undefined) {
      text += unescapeXml(match[1]);
    } else if (match[0].startsWith('<w:tab')) {
      text += '\t';
    } else {
      text += '\n';
    }
  }
  return text;
}

/** Paragraph style id, e.g. `Heading1`, or null for the default style. */
export function paragraphStyle(paragraphXml: string): string | null {
  const match = /<w:pStyle\s+w:val="([^"]*)"/.exec(paragraphXml);
  return match?.[1] ?? null;
}

export interface TextNode {
  /** Offset of the text content within the containing fragment. */
  contentStart: number;
  contentEnd: number;
  /** Decoded text. */
  text: string;
  /** Offset of this node's text within the concatenated paragraph text. */
  textStart: number;
  textEnd: number;
  /**
   * False for `<w:tab/>`, `<w:br/>` and `<w:cr/>`.
   *
   * These contribute a character to the concatenated text — `blockText` counts
   * them — but they carry no text content to rewrite, and splicing over them
   * would replace the element itself with a literal tab or newline. They occupy
   * their position and are otherwise left alone.
   */
  replaceable: boolean;
}

/** Locates every `<w:t>` text node inside a fragment, in document order. */
export function textNodes(fragment: string): TextNode[] {
  const nodes: TextNode[] = [];

  // Deliberately the same pattern `blockText` uses, and it must stay that way.
  //
  // These two functions define one coordinate system between them: `blockText`
  // produces the string that callers search for matches, and this function maps
  // those match offsets back onto the markup. When they walked different
  // elements they silently disagreed — this pattern used to match only `<w:t>`,
  // so every `<w:tab/>` or `<w:br/>` before a match shifted the replacement one
  // character late, leaving debris at the front of the placeholder and eating
  // the same number of characters off the end.
  //
  // That is not hypothetical: it corrupted the T1 joint signature block,
  // rewriting "[TAXPAYER 2 FULL LEGAL NAME]" followed by "Electronic signature"
  // into "[TAX<token>" followed by "tronic signature", in a template the firm
  // sends to clients.
  const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>/g;
  let match: RegExpExecArray | null;
  let textCursor = 0;

  while ((match = pattern.exec(fragment)) !== null) {
    if (match[1] === undefined) {
      // A tab or break: one character of the concatenated text, no content to
      // rewrite.
      nodes.push({
        contentStart: match.index,
        contentEnd: match.index + match[0].length,
        text: match[0].startsWith('<w:tab') ? '\t' : '\n',
        textStart: textCursor,
        textEnd: textCursor + 1,
        replaceable: false,
      });
      textCursor += 1;
      continue;
    }

    const raw = match[1];
    const decoded = unescapeXml(raw);
    const contentStart = match.index + match[0].length - raw.length - '</w:t>'.length;
    nodes.push({
      contentStart,
      contentEnd: contentStart + raw.length,
      text: decoded,
      textStart: textCursor,
      textEnd: textCursor + decoded.length,
      replaceable: true,
    });
    textCursor += decoded.length;
  }

  return nodes;
}

/**
 * Replaces ranges of the *concatenated* text of a fragment while preserving all
 * surrounding markup.
 *
 * The replacement is written into the first text node the range touches, so it
 * inherits that run's formatting; the remaining touched nodes have their
 * overlapping characters removed. This is what makes a placeholder split across
 * several runs (very common in Word) come out correctly formatted.
 */
export function replaceTextRanges(
  fragment: string,
  replacements: readonly { start: number; end: number; value: string }[],
): string {
  if (replacements.length === 0) return fragment;

  const nodes = textNodes(fragment);
  if (nodes.length === 0) return fragment;

  const ordered = [...replacements].sort((a, b) => a.start - b.start);

  // Rebuild each node's text in a single left-to-right pass so that several
  // replacements landing in the same run cannot corrupt each other's offsets.
  const newTexts = nodes.map((node) => {
    const pieces: string[] = [];
    let cursor = 0;

    for (const replacement of ordered) {
      if (replacement.end <= node.textStart || replacement.start >= node.textEnd) continue;

      const localStart = Math.max(0, replacement.start - node.textStart);
      const localEnd = Math.min(node.text.length, replacement.end - node.textStart);

      if (localStart > cursor) pieces.push(node.text.slice(cursor, localStart));

      // Only the run where the match begins receives the replacement value;
      // continuation runs simply drop their share of the matched characters.
      if (replacement.start >= node.textStart) pieces.push(replacement.value);

      cursor = Math.max(cursor, localEnd);
    }

    if (cursor < node.text.length) pieces.push(node.text.slice(cursor));
    return pieces.join('');
  });

  // Splice from the end so earlier offsets stay valid.
  let result = fragment;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (!node) continue;
    // A tab or break holds a position in the text but has no content to write
    // into; splicing it would replace the element with a literal tab character.
    if (!node.replaceable) continue;
    const replacementText = newTexts[index] ?? '';
    if (replacementText === node.text) continue;
    result = result.slice(0, node.contentStart) + escapeXml(replacementText) + result.slice(node.contentEnd);
  }

  return result;
}

/**
 * Ensures `<w:t>` elements keep their leading/trailing spaces.
 * Word drops them unless xml:space="preserve" is present.
 */
export function preserveSpaces(fragment: string): string {
  return fragment.replace(/<w:t(\s[^>]*?)?(\/?)>/g, (match, attributes: string | undefined, selfClosing: string) => {
    if (selfClosing === '/') return match;
    if (attributes && /xml:space=/.test(attributes)) return match;
    return `<w:t${attributes ?? ''} xml:space="preserve">`;
  });
}
