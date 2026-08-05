import { parseBody, resolveRange } from '../ooxml/blocks.js';
import { getPartText, MAIN_DOCUMENT_PART, readDocx } from '../ooxml/package.js';
import type { EditableSection, TemplateManifest } from './manifest.js';

/**
 * Reading the approved wording of an editable section out of a template.
 *
 * An editor needs the template's own words to start from and to compare
 * against, and they must come from the published template rather than from a
 * copy someone typed into a fixture — otherwise "restore the original" restores
 * something that was never approved.
 */

export interface EditableSectionText {
  key: string;
  label: string;
  editLevel: EditableSection['editLevel'];
  /** One entry per paragraph, in document order. */
  paragraphs: string[];
  /** The same text as a single editable string. */
  text: string;
}

/**
 * Extracts every editable section the manifest declares.
 *
 * A declared section that cannot be found in the template is an error the
 * caller must surface: it means the manifest and the document have drifted
 * apart, and an editor that silently offered nothing would look identical to a
 * template with nothing editable in it.
 */
export async function readEditableSections(
  templateDocx: Uint8Array | Buffer,
  manifest: TemplateManifest,
): Promise<{ sections: EditableSectionText[]; missing: string[] }> {
  const parts = await readDocx(templateDocx);
  const parsed = parseBody(getPartText(parts, MAIN_DOCUMENT_PART));

  const sections: EditableSectionText[] = [];
  const missing: string[] = [];

  for (const section of manifest.editableSections) {
    const range = resolveRange(parsed, section.range);
    if (!range) {
      missing.push(section.key);
      continue;
    }

    const paragraphs = parsed.blocks
      .slice(range.from, range.to)
      .filter((block) => block.tag === 'w:p' && block.text.length > 0)
      .map((block) => block.text);

    sections.push({
      key: section.key,
      label: section.label,
      editLevel: section.editLevel,
      paragraphs,
      text: paragraphs.join('\n\n'),
    });
  }

  return { sections, missing };
}
