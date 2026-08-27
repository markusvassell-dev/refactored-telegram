import { readFile, readdir } from 'node:fs/promises';
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

  // Superseded by SCAN_CLIENT_DOCUMENTS, which reads the same three scopes,
  // scores the same candidates and hands them to the same chooser — and keeps
  // what it read. Its handler is now a shim that enqueues the scan, kept only so
  // rows already queued when that shipped do not dead-letter. Nothing enqueues
  // it any more, and the handler goes a release later.
  LOCATE_PRIOR_YEAR_DOCUMENTS:
    'Superseded by SCAN_CLIENT_DOCUMENTS. The handler is a shim draining in-flight rows; delete it a release later.',

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
  // The prior-year search enqueue moved here when the worker's rollover needed
  // the same status and Karbon-link guards the web action already had. Two
  // copies of a guard is how two callers quietly stop agreeing.
  'packages/services/src/prior-year-search.ts',
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

/** Every .ts/.tsx file under the given directories, read once. */
async function collectSources(directories: string[]): Promise<string[]> {
  const files: string[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'generated') continue;
        await walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        files.push(full);
      }
    }
  }

  for (const directory of directories) await walk(directory);
  return Promise.all(files.map((file) => readFile(file, 'utf8')));
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

  /**
   * A shim exempted for forwarding has to actually forward.
   *
   * `LOCATE_PRIOR_YEAR_DOCUMENTS` is exempted above on the strength of one
   * claim: that it hands its work to the scan, so rows already queued when the
   * scan replaced it still get done. A shim that quietly returned instead would
   * satisfy every check here — it has a handler, and its exemption explains why
   * nothing enqueues it — while silently dropping those jobs. That is the same
   * shape as the defect this file was written for, one layer in.
   */
  it('forwards the superseded search to the scan rather than dropping it', async () => {
    const source = await readFile(join(process.cwd(), 'apps/worker/src/handlers.ts'), 'utf8');

    const handler = source.slice(
      source.indexOf('    LOCATE_PRIOR_YEAR_DOCUMENTS: async ('),
      source.indexOf('    SCAN_CLIENT_DOCUMENTS: async ('),
    );

    expect(handler, 'The LOCATE_PRIOR_YEAR_DOCUMENTS handler was not found before SCAN_CLIENT_DOCUMENTS.').not.toBe('');
    expect(
      handler.includes('enqueueClientDocumentScan'),
      'LOCATE_PRIOR_YEAR_DOCUMENTS is exempted from the reachability check because it forwards to the scan. It no longer does, so in-flight jobs are being dropped.',
    ).toBe(true);
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

  /**
   * The same defect, one layer down: a *table* the app can read and cannot write.
   *
   * `EngagementParticipant` was written only by the demo seed. Every real
   * engagement therefore had no signers, `evaluateSendGate` refuses an
   * engagement with no signers, and an approved letter had nowhere to go by
   * either route — Adobe could not be asked, and the manual bridge refused too,
   * telling the reviewer the engagement "names nobody who must sign" while
   * offering no way to name anybody. The Signers tab rendered the empty table
   * faithfully, so nothing looked broken.
   *
   * A model the UI displays but nothing can create is a dead end wearing the
   * costume of a feature.
   */
  it('can write every model whose rows the workspace displays', async () => {
    const root = process.cwd();

    // Models the engagement workspace reads and a person is expected to fill.
    const displayed = ['engagementParticipant', 'sourceDocument', 'extractedField', 'reviewComment'];

    const sources = await collectSources([
      join(root, 'packages/services/src'),
      join(root, 'apps/web/src/app'),
      join(root, 'apps/worker/src'),
    ]);

    const unwritable = displayed.filter(
      (model) =>
        !sources.some((source) =>
          new RegExp(`${model}\\.(create|createMany|upsert|update)`).test(source),
        ),
    );

    expect(
      unwritable,
      'These models are shown in the UI but nothing outside the seed can create or update them:\n' +
        unwritable.map((model) => `  - ${model}`).join('\n'),
    ).toEqual([]);
  });

  it('reads the client’s documents from preparation, not only from a webhook', async () => {
    // The specific regression. The webhook alone is not enough: no tenant had
    // ever configured a Karbon status trigger, and `karbon_status_triggers` is
    // seeded empty, so a webhook-only caller means nothing ever reads a document.
    //
    // Followed twice now rather than deleted. The literal `jobType` first moved
    // out of `actions.ts` into `@element/services` so the worker's rollover
    // could share it; then the targeted prior-year search was replaced here by
    // the whole-library scan, which scores the same candidates and hands them to
    // the same chooser. What has to stay true is the property, not the name: a
    // person pressing Prepare must reach an enqueue that reads documents.
    const actions = await readFile(join(process.cwd(), 'apps/web/src/app/actions.ts'), 'utf8');
    const helper = await readFile(
      join(process.cwd(), 'packages/services/src/prior-year-search.ts'),
      'utf8',
    );

    expect(helper).toContain("jobType: 'SCAN_CLIENT_DOCUMENTS'");
    expect(actions).toContain('enqueueClientDocumentScan');

    // Preparation must call it, not merely import it.
    const prepareBody = actions.slice(actions.indexOf('export async function prepareEngagement'));
    expect(prepareBody.slice(0, 2_000)).toContain('scanClientDocumentsInBackground(engagementId');
  });

  it('prepares an engagement whether or not any document is found', async () => {
    // The other half, and the reason the Matador engagement sat with its
    // corporation name blank: `PREPARE_ENGAGEMENT` used to be enqueued from
    // exactly one place, the last line of extraction. No document meant no
    // preparation, and preparation is what records the client's own details.
    const actions = await readFile(join(process.cwd(), 'apps/web/src/app/actions.ts'), 'utf8');
    const handlers = await readFile(join(process.cwd(), 'apps/worker/src/handlers.ts'), 'utf8');
    const helper = await readFile(
      join(process.cwd(), 'packages/services/src/preparation-enqueue.ts'),
      'utf8',
    );

    expect(helper).toContain("jobType: 'PREPARE_ENGAGEMENT'");
    // Creating an engagement, and finishing a scan that found nothing.
    expect(actions).toContain('prepareInBackground');
    expect(handlers).toContain('enqueuePreparation');
  });

  it('reaches the rollover from both the webhook and the poll', async () => {
    // The same defect one layer up. `ROLL_OVER_ENGAGEMENT` is what creates the
    // engagement a rollover needs, and until it is enqueued by something that
    // actually runs it is another well-tested handler nothing calls. The
    // webhook has never carried a request — nothing subscribes to Karbon's
    // webhooks and its payload shape is unverified — so the poll is the caller
    // that has to exist.
    const route = await readFile(
      join(process.cwd(), 'apps/web/src/app/api/webhooks/karbon/route.ts'),
      'utf8',
    );
    const handlers = await readFile(join(process.cwd(), 'apps/worker/src/handlers.ts'), 'utf8');
    const worker = await readFile(join(process.cwd(), 'apps/worker/src/index.ts'), 'utf8');

    expect(route).toContain("jobType: 'ROLL_OVER_ENGAGEMENT'");
    expect(handlers).toContain("jobType: 'ROLL_OVER_ENGAGEMENT'");
    expect(worker).toContain("jobType: 'POLL_KARBON_TRIGGERS'");
  });

  it('never generates a document from the automatic rollover', async () => {
    // The line the whole feature rests on: preparation proposes and a person
    // confirms. An engagement that started itself does not move that boundary,
    // and the way that would break is somebody adding a convenience enqueue to
    // the rollover handler months from now.
    const handlers = await readFile(join(process.cwd(), 'apps/worker/src/handlers.ts'), 'utf8');
    const start = handlers.indexOf('ROLL_OVER_ENGAGEMENT: async');
    const end = handlers.indexOf('SYNC_CLIENT_DOCUMENTS: async');

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(handlers.slice(start, end)).not.toContain('GENERATE_ENGAGEMENT_LETTER');
  });
});
