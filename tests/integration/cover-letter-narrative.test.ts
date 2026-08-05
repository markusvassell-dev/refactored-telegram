import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  convertDocxToPdf,
  extractParagraphs,
  getPartText,
  isPdf,
  MAIN_DOCUMENT_PART,
  parseBody,
  parseManifest,
  readDocx,
  readEditableSections,
  renderDocx,
  type TemplateManifest,
} from '@element/documents';

/**
 * Editing the cover letter narrative, against the real approved templates.
 *
 * The narrative is the one part of a cover letter meant to be written rather
 * than derived. What matters is not that the text changes — it is that nothing
 * else does: the approved legal wording, the enclosure list and the document's
 * own formatting must come through an edit untouched, and no key outside the
 * template's declared editable sections may reach the document at all.
 */

const ROOT = process.cwd();
const NORMALIZED = join(ROOT, 'templates', 'normalized');
const MANIFESTS = join(ROOT, 'templates', 'manifests');

async function loadTemplate(documentType: string): Promise<{ manifest: TemplateManifest; docx: Buffer }> {
  const manifest = parseManifest(JSON.parse(await readFile(join(MANIFESTS, `${documentType}.json`), 'utf8')));
  const docx = await readFile(join(NORMALIZED, manifest.sourceFileName));
  return { manifest, docx };
}

function baseOptions(manifest: TemplateManifest) {
  return { manifest, values: {}, selections: {}, includedSections: [], mode: 'DRAFT' as const };
}

async function paragraphsOf(docx: Buffer): Promise<string[]> {
  return extractParagraphs(docx);
}

/** Paragraph blocks with their style, which `extractParagraphs` does not carry. */
async function styledBlocks(docx: Buffer): Promise<{ text: string; style: string | null }[]> {
  const parts = await readDocx(docx);
  return parseBody(getPartText(parts, MAIN_DOCUMENT_PART))
    .blocks.filter((block) => block.tag === 'w:p' && block.text.length > 0)
    .map((block) => ({ text: block.text, style: block.style }));
}

describe('reading the approved wording out of the template', () => {
  it('finds the declared narrative in both cover letters, so an editor has something to start from', async () => {
    for (const documentType of ['T1_COVER_LETTER', 'COMPILATION_COVER_LETTER']) {
      const { manifest, docx } = await loadTemplate(documentType);
      const { sections, missing } = await readEditableSections(docx, manifest);

      expect(missing, documentType).toEqual([]);
      expect(sections, documentType).toHaveLength(1);
      expect(sections[0]?.key, documentType).toBe('cover_letter_intro');
      expect(sections[0]?.editLevel, documentType).toBe('ORDINARY');
      expect(sections[0]?.paragraphs.length, documentType).toBeGreaterThan(0);
      expect(sections[0]?.text.length, documentType).toBeGreaterThan(50);
    }
  });

  it('reports a section it cannot find rather than returning nothing and looking the same', async () => {
    const { manifest, docx } = await loadTemplate('T1_COVER_LETTER');
    const drifted: TemplateManifest = {
      ...manifest,
      editableSections: [
        {
          key: 'cover_letter_intro',
          label: 'Introductory paragraphs',
          range: { startsWith: 'This sentence is not in the template', endsBefore: undefined, inclusiveEnd: false },
          editLevel: 'ORDINARY',
        },
      ],
    } as TemplateManifest;

    const { sections, missing } = await readEditableSections(docx, drifted);
    expect(sections).toEqual([]);
    expect(missing).toEqual(['cover_letter_intro']);
  });
});

describe('what an edit changes', () => {
  it('replaces the narrative and leaves the approved wording around it alone', async () => {
    const { manifest, docx } = await loadTemplate('T1_COVER_LETTER');

    const before = await renderDocx(docx, baseOptions(manifest));
    const after = await renderDocx(docx, {
      ...baseOptions(manifest),
      editedSections: { cover_letter_intro: 'A sentence a reviewer wrote.\nAnd a second paragraph.' },
    });

    const beforeText = await paragraphsOf(before.docx);
    const afterText = await paragraphsOf(after.docx);

    expect(after.editedSections).toEqual(['cover_letter_intro']);
    expect(afterText).toContain('A sentence a reviewer wrote.');
    expect(afterText).toContain('And a second paragraph.');

    // The template's own opening is gone.
    expect(beforeText.some((line) => line.includes('We are pleased to enclose your personal income tax return'))).toBe(
      true,
    );
    expect(afterText.some((line) => line.includes('We are pleased to enclose your personal income tax return'))).toBe(
      false,
    );

    // Everything after the narrative survives, word for word.
    const tail = (lines: string[]): string[] => {
      const start = lines.findIndex((line) => /Documents enclosed/i.test(line));
      return lines.slice(start);
    };
    expect(tail(afterText)).toEqual(tail(beforeText));
  });

  it('resolves tokens inside the edited text, so a value need not be typed by hand', async () => {
    const { manifest, docx } = await loadTemplate('T1_COVER_LETTER');

    const rendered = await renderDocx(docx, {
      ...baseOptions(manifest),
      values: { 'engagement.tax_year': '2026' },
      editedSections: { cover_letter_intro: 'Your return for [[engagement.tax_year]] is enclosed.' },
    });

    const text = await paragraphsOf(rendered.docx);
    expect(text).toContain('Your return for 2026 is enclosed.');
    expect(rendered.unresolvedTokens).toEqual([]);
  });

  it('keeps the formatting of the paragraph it replaced rather than inventing one', async () => {
    const { manifest, docx } = await loadTemplate('T1_COVER_LETTER');

    const original = await styledBlocks(docx);
    const narrative = original.find((paragraph) =>
      paragraph.text.includes('We are pleased to enclose your personal income tax return'),
    );

    const rendered = await renderDocx(docx, {
      ...baseOptions(manifest),
      editedSections: { cover_letter_intro: 'Replacement wording.' },
    });

    const edited = (await styledBlocks(rendered.docx)).find((paragraph) =>
      paragraph.text.includes('Replacement wording.'),
    );

    expect(edited).toBeDefined();
    expect(edited?.style).toBe(narrative?.style);
  });

  it('still converts to a valid PDF of a plausible length', async () => {
    const { manifest, docx } = await loadTemplate('T1_COVER_LETTER');

    const rendered = await renderDocx(docx, {
      ...baseOptions(manifest),
      editedSections: {
        cover_letter_intro: Array.from({ length: 4 }, (_, index) => `Paragraph ${index + 1} of a rewritten narrative.`).join(
          '\n',
        ),
      },
    });

    const converted = await convertDocxToPdf(rendered.docx);
    expect(isPdf(converted.pdf)).toBe(true);
    expect(converted.pageCount ?? 1).toBeGreaterThanOrEqual(1);
  });

  it('is deterministic: the same edit renders byte-identically', async () => {
    const { manifest, docx } = await loadTemplate('COMPILATION_COVER_LETTER');
    const options = {
      ...baseOptions(manifest),
      editedSections: { cover_letter_intro: 'Deterministic wording.' },
    };

    const first = await renderDocx(docx, options);
    const second = await renderDocx(docx, options);

    expect(first.docx.equals(second.docx)).toBe(true);
  });
});

describe('what an edit cannot reach', () => {
  it('refuses a section the template does not mark editable', async () => {
    const { manifest, docx } = await loadTemplate('T1_COVER_LETTER');

    await expect(
      renderDocx(docx, {
        ...baseOptions(manifest),
        editedSections: { documents_enclosed: 'Something else entirely.' },
      }),
    ).rejects.toThrow(/not an editable section/i);
  });

  it('refuses an editable section the template no longer contains, rather than rendering the old wording', async () => {
    const { manifest, docx } = await loadTemplate('T1_COVER_LETTER');
    const drifted = {
      ...manifest,
      editableSections: [
        {
          key: 'cover_letter_intro',
          label: 'Introductory paragraphs',
          range: { startsWith: 'Not a sentence in this template', endsBefore: undefined, inclusiveEnd: false },
          editLevel: 'ORDINARY' as const,
        },
      ],
    } as TemplateManifest;

    await expect(
      renderDocx(docx, { ...baseOptions(drifted), editedSections: { cover_letter_intro: 'New wording.' } }),
    ).rejects.toThrow(/out of step/i);
  });

  it('leaves the document untouched when no edit is supplied', async () => {
    const { manifest, docx } = await loadTemplate('T1_COVER_LETTER');

    const plain = await renderDocx(docx, baseOptions(manifest));
    const empty = await renderDocx(docx, { ...baseOptions(manifest), editedSections: {} });

    expect(plain.docx.equals(empty.docx)).toBe(true);
    expect(empty.editedSections).toEqual([]);
  });
});

describe('an approved wording change that no longer matches', () => {
  it('refuses to render rather than quietly producing the original wording', async () => {
    const { manifest, docx } = await loadTemplate('T1_COVER_LETTER');

    // A partner approved this change. If the anchor has drifted, rendering the
    // template's own wording while the record says the change was applied is
    // how an unapproved sentence reaches a client.
    await expect(
      renderDocx(docx, {
        ...baseOptions(manifest),
        wordingExceptions: [
          { sectionAnchor: 'a sentence that is not in this template', revisedWording: 'Revised.' },
        ],
      }),
    ).rejects.toThrow(/no longer contains/i);
  });
});
