import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JOB_TYPES, type JobType } from '@element/services';

/**
 * Every job the worker can run must be reachable from something that runs.
 *
 * This test exists because of a defect that passed every other one. The
 * prior-year document search — `LOCATE_PRIOR_YEAR_DOCUMENTS` — was implemented,
 * covered by tests, and correct. Its handler searched the work item, then the
 * prior year's work items, then the client's document area, and scored each
 * candidate on its text. It simply never ran: the only thing that enqueued it
 * was the Karbon status webhook, and `karbon_status_triggers` ships as `[]`, so
 * on a tenant that had never configured a status trigger nothing ever asked.
 * Every engagement told the reviewer to upload last year's letter by hand while
 * the application held, untouched, the code to go and find it.
 *
 * The handler tests passed throughout, because a handler test calls the handler.
 * Nothing asserted that the application does.
 *
 * `DETECT_STALE_SOURCES` was the same shape and worse: the cover-letter
 * approval gate reads a staleness flag that only that job's service call ever
 * raises, so the gate was reading an input that was always false.
 *
 * So: a job type is either enqueued somewhere, or it is listed below with the
 * reason it is not. Adding a handler and forgetting the caller now fails here
 * instead of in production, silently, a year later.
 */

/**
 * Job types with no enqueue site, and why that is currently acceptable.
 *
 * This is a list of known gaps, not a list of approved ones. Anything here is
 * dead or waiting on work that has not been done — it is not "fine".
 */
const UNREACHABLE_BY_DESIGN: Partial<Record<JobType, string>> = {
  // Adobe Acrobat Sign is not built yet. The firm holds Acrobat Pro, which has
  // no agreement API; signing goes through the external-signature bridge
  // instead. This handler is the placeholder for when that changes.
  CREATE_ADOBE_AGREEMENT:
    'Adobe Sign integration is not built. Signatures are recorded through the external-signature bridge.',

  // Superseded: generation and cover-letter rendering both convert inline
  // (generation-service.ts, cover-letter-service.ts) because the review screen
  // needs the PDF in the same request that produced the DOCX.
  CONVERT_PDF: 'Superseded — conversion happens inline during generation.',

  // Superseded: the review workspace computes a comparison on demand. The
  // handler is a stub that stores nothing.
  COMPARE_DOCUMENTS: 'Superseded — comparison is computed on demand in the review workspace.',

  // Cover-letter source extraction currently runs through EXTRACT_DOCUMENT_TEXT
  // against an uploaded document. This variant reads from Karbon directly and
  // has no caller until cover-letter sources are pulled from Karbon.
  EXTRACT_COVER_LETTER_DATA: 'No caller until cover-letter sources are pulled from Karbon rather than uploaded.',

  // Superseded deliberately: `CoverLetterService.approve` now calls
  // `detectStaleSources` directly, before it reads the staleness flag the
  // delivery gate depends on. A background job could not have been the answer
  // here — approving is exactly the moment the check must be current, and a
  // queued check can be outrun by a fast approval.
  DETECT_STALE_SOURCES: 'Superseded — CoverLetterService.approve detects staleness inline, before the gate reads it.',
};

const SOURCE_FILES = [
  'apps/web/src/app/actions.ts',
  'apps/web/src/app/api/webhooks/karbon/route.ts',
  'apps/worker/src/handlers.ts',
  'apps/worker/src/index.ts',
  'packages/services/src/bulk-rollout.ts',
];

async function enqueuedJobTypes(): Promise<Set<string>> {
  const found = new Set<string>();
  const root = process.cwd();

  for (const file of SOURCE_FILES) {
    const source = await readFile(join(root, file), 'utf8');
    for (const match of source.matchAll(/jobType:\s*'([A-Z_]+)'/g)) {
      found.add(match[1] as string);
    }
  }

  return found;
}

/** Job types the worker actually registers a handler for. */
async function handledJobTypes(): Promise<Set<string>> {
  const source = await readFile(join(process.cwd(), 'apps/worker/src/handlers.ts'), 'utf8');
  const found = new Set<string>();
  for (const match of source.matchAll(/^ {4}([A-Z_]+):\s*async\s*\(/gm)) {
    found.add(match[1] as string);
  }
  return found;
}

describe('background job reachability', () => {
  it('enqueues every job the worker handles, or names why it cannot', async () => {
    const enqueued = await enqueuedJobTypes();
    const handled = await handledJobTypes();

    const unreachable = [...handled]
      .filter((jobType) => !enqueued.has(jobType))
      .filter((jobType) => !(jobType in UNREACHABLE_BY_DESIGN));

    expect(
      unreachable,
      `These job types have a handler and no caller, so they never run:\n` +
        unreachable.map((jobType) => `  - ${jobType}`).join('\n') +
        `\n\nEither enqueue them, or add them to UNREACHABLE_BY_DESIGN with the reason.`,
    ).toEqual([]);
  });

  it('finds a handler for every job type the queue declares', async () => {
    const handled = await handledJobTypes();
    const missing = JOB_TYPES.filter((jobType) => !handled.has(jobType));

    expect(missing, `Declared in JOB_TYPES with no handler: ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps the exemption list honest', async () => {
    const enqueued = await enqueuedJobTypes();

    // An exempted job that has since gained a caller must lose its exemption,
    // otherwise the list rots into a place where real gaps go to hide.
    const stale = Object.keys(UNREACHABLE_BY_DESIGN).filter((jobType) => enqueued.has(jobType));

    expect(stale, `These are now enqueued and must be removed from UNREACHABLE_BY_DESIGN: ${stale.join(', ')}`).toEqual(
      [],
    );
  });

  it('starts the prior-year search from preparation, not only from a webhook', async () => {
    // The specific regression. The webhook alone is not enough: no tenant has
    // ever configured a Karbon status trigger, and `karbon_status_triggers` is
    // seeded empty, so a webhook-only caller means the search never runs.
    const actions = await readFile(join(process.cwd(), 'apps/web/src/app/actions.ts'), 'utf8');

    expect(actions).toContain("jobType: 'LOCATE_PRIOR_YEAR_DOCUMENTS'");
    expect(actions).toContain('enqueuePriorYearSearch');

    // Preparation must call it, not merely define it.
    const prepareBody = actions.slice(actions.indexOf('export async function prepareEngagement'));
    expect(prepareBody.slice(0, 2_000)).toContain('enqueuePriorYearSearch(engagementId');
  });
});
