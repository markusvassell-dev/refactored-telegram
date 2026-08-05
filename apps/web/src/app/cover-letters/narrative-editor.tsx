'use client';

import { useMemo, useState } from 'react';
import { ActionForm } from '@/components/action-form';
import { saveCoverLetterNarrative, restoreCoverLetterNarrative } from '@/app/actions';

/**
 * The cover letter narrative editor.
 *
 * The narrative is the one part of the letter meant to be written rather than
 * derived. Everything around it — the approved legal wording, the enclosure
 * list, the amounts — is not reachable from here: the server accepts only the
 * section keys the approved template marks editable, so this component cannot
 * offer a box that would edit anything else.
 *
 * The approved wording sits beside the editor rather than behind a link,
 * because the question a reviewer actually has is "what did this used to say".
 */

export interface NarrativeSectionView {
  key: string;
  label: string;
  originalText: string;
  effectiveText: string;
  edit: {
    editedText: string;
    reason: string | null;
    authorName: string;
    createdAt: string;
    fromSupersededTemplate: boolean;
  } | null;
}

/** Paragraph-level difference. Enough to answer "what changed", cheaply. */
function diffParagraphs(before: string, after: string): { tone: 'same' | 'added' | 'removed'; text: string }[] {
  const from = before.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const to = after.split(/\n+/).map((line) => line.trim()).filter(Boolean);

  const rows: { tone: 'same' | 'added' | 'removed'; text: string }[] = [];
  const remaining = [...from];

  for (const paragraph of to) {
    const index = remaining.indexOf(paragraph);
    if (index === -1) {
      rows.push({ tone: 'added', text: paragraph });
    } else {
      // Anything skipped over was in the original and is not in the new text.
      for (const dropped of remaining.splice(0, index)) rows.push({ tone: 'removed', text: dropped });
      remaining.shift();
      rows.push({ tone: 'same', text: paragraph });
    }
  }

  for (const dropped of remaining) rows.push({ tone: 'removed', text: dropped });
  return rows;
}

export function NarrativeEditor({
  coverLetterPackageId,
  section,
  csrfToken,
  canEdit,
}: {
  coverLetterPackageId: string;
  section: NarrativeSectionView;
  csrfToken: string;
  canEdit: boolean;
}) {
  const [text, setText] = useState(section.effectiveText);

  const changes = useMemo(
    () => diffParagraphs(section.originalText, text).filter((row) => row.tone !== 'same'),
    [section.originalText, text],
  );

  const isEdited = text.trim() !== section.originalText.trim();
  const fieldId = `narrative-${coverLetterPackageId}-${section.key}`;

  if (!canEdit) {
    return (
      <div>
        <h3 className="text-sm font-semibold">{section.label}</h3>
        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{section.effectiveText}</p>
        {section.edit ? (
          <p className="mt-1 text-xs text-slate-500">
            Edited by {section.edit.authorName} on {section.edit.createdAt}.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{section.label}</h3>
        {section.edit ? (
          <span className="badge bg-blue-100 text-blue-800">
            edited by {section.edit.authorName} on {section.edit.createdAt}
          </span>
        ) : (
          <span className="badge bg-slate-100 text-slate-600">template wording</span>
        )}
      </div>

      {section.edit?.fromSupersededTemplate ? (
        <p role="note" className="mt-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          This edit was made against an earlier version of the template. The comparison below is against the wording
          that is approved now, which may differ from what the author saw.
        </p>
      ) : null}

      <ActionForm
        action={saveCoverLetterNarrative}
        csrfToken={csrfToken}
        submitLabel="Save narrative"
        variant="secondary"
      >
        <input type="hidden" name="coverLetterPackageId" value={coverLetterPackageId} />
        <input type="hidden" name="sectionKey" value={section.key} />

        <div className="grid gap-3 lg:grid-cols-2">
          <div>
            <label className="label" htmlFor={fieldId}>
              Narrative
            </label>
            <textarea
              id={fieldId}
              name="text"
              rows={10}
              className="input font-serif"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <p className="mt-1 text-xs text-slate-500">
              One paragraph per line. Tokens such as <code>[[engagement.tax_year]]</code> still resolve, so a value need
              not be typed in by hand.
            </p>
          </div>

          <div>
            <p className="label">Approved template wording</p>
            <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
              {section.originalText}
            </div>
          </div>
        </div>

        {isEdited ? (
          <div>
            <p className="label">What changes</p>
            <ul className="space-y-1 text-sm">
              {changes.map((row, index) => (
                <li
                  key={`${row.tone}-${index}`}
                  className={
                    row.tone === 'added'
                      ? 'rounded bg-emerald-50 px-2 py-1 text-emerald-900'
                      : 'rounded bg-red-50 px-2 py-1 text-red-900 line-through'
                  }
                >
                  <span className="mr-2 font-mono text-xs">{row.tone === 'added' ? '+' : '−'}</span>
                  {row.text}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-slate-500">Unchanged from the approved template wording.</p>
        )}

        <div>
          <label className="label" htmlFor={`reason-${fieldId}`}>
            Why (optional, recorded in the audit trail)
          </label>
          <input id={`reason-${fieldId}`} name="reason" className="input" />
        </div>
      </ActionForm>

      {section.edit ? (
        <div className="mt-2">
          <ActionForm
            action={restoreCoverLetterNarrative}
            csrfToken={csrfToken}
            submitLabel="Restore template wording"
            variant="secondary"
            confirm="This discards the edit and goes back to the approved template wording. Continue?"
          >
            <input type="hidden" name="coverLetterPackageId" value={coverLetterPackageId} />
            <input type="hidden" name="sectionKey" value={section.key} />
          </ActionForm>
        </div>
      ) : null}
    </div>
  );
}
