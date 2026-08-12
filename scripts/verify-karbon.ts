import { PrismaClient } from '@element/database';
import { KarbonRestClient, type KarbonProvider, type KarbonWorkItem } from '@element/integrations';
import {
  AppError,
  createLogger,
  decryptSecret,
  describeBuild,
  describeDatabaseProblem,
  describeSandboxMislabel,
  formatDatabaseProblem,
  loadEnv,
} from '@element/shared';

/**
 * Exercising Karbon against a real tenant.
 *
 * Every capability in the matrix is `UNVERIFIED`: implemented against Karbon's
 * published documentation and never run against a live account from this
 * project. Promoting a row is not a code change — it is evidence — and the
 * checklist step that produced that evidence was "exercise each operation
 * against the sandbox with a test work item", which is a morning of careful
 * manual work nobody repeats.
 *
 * This is that morning, as one command. It reports what each operation
 * actually did, including the vendor's own error text, so the matrix can be
 * updated from observation.
 *
 * Two safety properties, both deliberate:
 *
 *   - It uses the credentials already stored on the Integrations screen. There
 *     is no second home for a Karbon credential, and no way to pass one on the
 *     command line where it would land in a shell history.
 *   - It performs **no writes** unless asked, never writes to a work item
 *     nobody named, and needs a second explicit flag before writing to a
 *     production tenant. Reading a production tenant is harmless; writing to
 *     one by accident, or to whichever work item a search happened to return,
 *     is not.
 *
 * Usage:
 *   pnpm verify:karbon                          # read-only
 *   pnpm verify:karbon --work-item KEY          # exercise a specific work item
 *   pnpm verify:karbon --allow-writes --work-item KEY
 *
 * Writing to a production tenant additionally needs --write-to-production, and
 * a work item you have chosen. Most firms have no Karbon sandbox, so refusing
 * production writes outright would mean the write capabilities the application
 * depends on could never be verified at all.
 */

type Outcome = 'PASS' | 'FAIL' | 'SKIP';

interface Result {
  capability: string;
  outcome: Outcome;
  detail: string;
}

const results: Result[] = [];

function record(capability: string, outcome: Outcome, detail: string): void {
  results.push({ capability, outcome, detail });
  const mark = outcome === 'PASS' ? '  ok  ' : outcome === 'FAIL' ? ' FAIL ' : ' skip ';
  process.stdout.write(`[${mark}] ${capability.padEnd(26)} ${detail}\n`);
}

/**
 * Runs one capability, turning any throw into a recorded failure.
 *
 * `proves` decides whether the result is evidence the operation works. Not
 * throwing is not the same as working: a read that 404s comes back as `null` by
 * design — "a read that found nothing is an answer" — so without this, an
 * operation that found nothing was recorded as passing. `READ_WORK_ITEM` was
 * reported `ok  not found`, against a key `SEARCH_WORK_ITEMS` had just
 * returned, and that reading is what promoted the row to Supported in the
 * matrix.
 */
async function attempt<T>(
  capability: string,
  run: () => Promise<T>,
  describe: (value: T) => string,
  proves: (value: T) => boolean = () => true,
): Promise<T | null> {
  try {
    const value = await run();
    const detail = describe(value);
    if (proves(value)) {
      record(capability, 'PASS', detail);
      return value;
    }
    record(capability, 'FAIL', `${detail} — the call succeeded but returned nothing, so this proves nothing`);
    return value;
  } catch (error) {
    // The vendor's own message is the point of this script — and it was being
    // thrown away. `HTTP 400 for /Notes` says a request was rejected and
    // nothing about why; Karbon's body says which field it objected to, and
    // that body was sitting in the error's context, unprinted. A verification
    // harness that hides the vendor's explanation is a harness that turns one
    // command into a guessing game.
    record(capability, 'FAIL', describeFailure(error));
    return null;
  }
}

/** The vendor's own words, where it gave any. */
function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const detail = error instanceof AppError ? error.context.detail : undefined;

  if (typeof detail !== 'string' || detail.trim().length === 0) return message;
  // Karbon answers with JSON; unwrap the human-readable part when it is there.
  return `${message}\n${' '.repeat(37)}${detail.trim().replace(/\s*\n\s*/g, ' ').slice(0, 400)}`;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const allowWrites = process.argv.includes('--allow-writes');

/**
 * Saying out loud that this run writes to a real tenant.
 *
 * Separate from --allow-writes on purpose: the first says "include writes", the
 * second says "yes, to production, and I have chosen where". A single flag
 * meaning both is one someone passes without reading.
 */
const acknowledgedProduction = process.argv.includes('--write-to-production');

/**
 * How many work items to consider when hunting for one with a document on it.
 *
 * Small on purpose. This is a verification run, not a survey, and the account's
 * request budget is shared with everything else the firm has connected.
 */
const CANDIDATE_LIMIT = 25;

async function main(): Promise<void> {
  const env = loadEnv();
  const prisma = new PrismaClient();
  const logger = createLogger({ level: 'warn', base: { service: 'verify-karbon' } });

  try {
    const connection = await prisma.integrationConnection.findUnique({ where: { provider: 'KARBON' } });

    if (!connection || !connection.encryptedCredentials) {
      fail(
        'No Karbon connection is configured.',
        'Open the Integrations screen, enter the bearer token and access key, leave the environment set to Sandbox, and save.',
      );
    }

    let credentials: { bearerToken?: string; accessKey?: string } = {};
    try {
      credentials = JSON.parse(decryptSecret(connection.encryptedCredentials, env.ENCRYPTION_KEY));
    } catch {
      fail(
        'The stored Karbon credentials could not be decrypted.',
        'ENCRYPTION_KEY has probably changed since they were entered. Re-enter them on the Integrations screen.',
      );
    }

    if (!credentials.bearerToken || !credentials.accessKey) {
      fail('The stored Karbon connection is missing a bearer token or an access key.', 'Re-enter both on the Integrations screen.');
    }

    const environment = connection.isSandbox ? 'SANDBOX' : 'PRODUCTION';
    process.stdout.write(`\nKarbon verification\n`);
    // Which code is speaking. A run once reported three failures that were
    // already fixed on the branch, and nothing in its output distinguished
    // "Karbon rejects this" from "this container is a week old".
    process.stdout.write(`  build        ${describeBuild()}\n`);
    process.stdout.write(`  base URL     ${connection.baseUrl ?? env.KARBON_API_BASE_URL}\n`);
    process.stdout.write(`  environment  ${environment}\n`);
    process.stdout.write(`  used by app  ${connection.isEnabled ? 'yes' : 'NO — the application is using the mock adapter'}\n`);
    process.stdout.write(`  writes       ${writeMode(connection.isSandbox)}\n\n`);

    const mislabel = describeSandboxMislabel({
      provider: 'KARBON',
      baseUrl: connection.baseUrl ?? env.KARBON_API_BASE_URL,
      isSandbox: connection.isSandbox,
    });
    if (mislabel) {
      process.stdout.write(`  WARNING: ${mislabel}\n\n`);
    }

    // This script reads the credentials directly, so it verifies a connection
    // the application itself may not be using. Passing every check while the
    // app quietly runs on a mock is exactly the kind of mismatch that makes an
    // integration look finished when nothing is wired to it.
    if (!connection.isEnabled) {
      process.stdout.write('  NOTE: "Use this connection" is set to No on the Integrations screen, so\n');
      process.stdout.write('        everything below tests credentials the application is not using.\n');
      process.stdout.write('        Set it to Yes once these checks pass.\n\n');
    }

    // Writing to production is not forbidden outright, because for most firms
    // there is no Karbon sandbox to write to — and refusing outright means the
    // write capabilities the application depends on can never be verified at
    // all. UPLOAD_DOCUMENT is how a signed engagement letter reaches the
    // client's permanent file; shipping it unverified for ever is its own risk.
    //
    // What is forbidden is writing to production *by accident*, or to a work
    // item nobody chose. Both extra requirements exist to make the operator
    // name the target and say out loud what they are doing.
    if (allowWrites && !connection.isSandbox) {
      if (!acknowledgedProduction) {
        fail(
          'Refusing to write to a production Karbon tenant without an explicit acknowledgement.',
          'Create a DUMMY CLIENT in Karbon and a work item under it — something obviously not real, like "Matador Pizza".\n' +
            'Do not use a real client’s work item, and do not use a real internal one either: verification writes land on a\n' +
            'record somebody may later read as genuine, and a note nobody can account for is worse than no note.\n' +
            'Open it, and take the key from the end of its URL: eleven or twelve letters and digits, like wfyFwlWGZms.\n' +
            'Then re-run with that key in place of the last word below — the word itself is not a key and will not work:\n' +
            '  pnpm verify:karbon --allow-writes --write-to-production --work-item PasteTheKeyHere',
        );
      }
      if (!argument('work-item')) {
        fail(
          'Refusing to choose which production work item to write to.',
          'Name it with --work-item. Without one this script writes to whichever work item the search happened to return, which is somebody’s live engagement.',
        );
      }
    }

    // The same rule in a sandbox, for a different reason: a run that writes to
    // an arbitrary work item tells you the call succeeded but leaves the test
    // data somewhere nobody is looking for it.
    if (allowWrites && !argument('work-item')) {
      fail(
        'Refusing to write to a work item nobody chose.',
        'Name the work item to write to with --work-item.',
      );
    }

    const client: KarbonProvider = new KarbonRestClient({
      baseUrl: connection.baseUrl ?? env.KARBON_API_BASE_URL,
      bearerToken: credentials.bearerToken,
      accessKey: credentials.accessKey,
      noteAuthorEmail: env.KARBON_NOTE_AUTHOR_EMAIL,
      logger,
    });

    await verify(client, argument('work-item'));
  } finally {
    await prisma.$disconnect();
  }

  summarise();
}

function writeMode(isSandbox: boolean): string {
  if (!allowWrites) return 'read-only (pass --allow-writes to include them)';
  if (isSandbox) return 'ENABLED — this will create test data in the sandbox';
  return acknowledgedProduction
    ? 'ENABLED AGAINST PRODUCTION — real test data, on the work item you named'
    : 'refused (production tenant; see --write-to-production)';
}

async function verify(client: KarbonProvider, workItemKey: string | undefined): Promise<void> {
  // ---- Connectivity -------------------------------------------------------
  const health = await attempt(
    'HEALTH_CHECK',
    () => client.healthCheck(),
    (value) => (value.ok ? 'reachable and authenticated' : `reachable, not accepted: ${value.detail ?? 'no detail'}`),
  );

  if (!health?.ok) {
    record('SEARCH_WORK_ITEMS', 'SKIP', 'no usable connection; nothing further was attempted');
    return;
  }

  // ---- Reads --------------------------------------------------------------
  // Enough to find one with documents on it, not enough to walk a tenant.
  // Downloading a prior-year letter is the operation the whole rollout depends
  // on, and it can only be verified against a work item that actually has one.
  const found = await attempt(
    'SEARCH_WORK_ITEMS',
    () => client.searchWorkItems({ limit: CANDIDATE_LIMIT }),
    (items) => `${items.length} work item(s) returned (asked for at most ${CANDIDATE_LIMIT})`,
  );

  const named = workItemKey
    ? await attempt(
        'READ_WORK_ITEM',
        () => client.getWorkItem(workItemKey),
        (item) => (item ? `"${item.title}"` : `no work item with key ${workItemKey}`),
        (item) => item !== null,
      )
    : null;

  // A named key that does not resolve must stop the run, not quietly fall back.
  // The fallback existed for the read-only case, where landing on some other
  // work item costs nothing. With writes enabled it silently retargeted them at
  // whichever work item the search happened to return — somebody's live
  // engagement — which is the exact outcome --work-item exists to prevent. It
  // happened: a run passed the literal placeholder `KEY`, which resolved to
  // nothing, and the writes went at a real client's work item instead.
  if (workItemKey && !named && allowWrites) {
    fail(
      `No work item has the key "${workItemKey}", so there is nowhere you have chosen to write.`,
      'Refusing to fall back to whichever work item the search returned first — that is somebody’s live engagement. Take the key from the Karbon URL of a work item you are willing to have test data written to.',
    );
  }

  const subject: KarbonWorkItem | null = named ?? found?.[0] ?? null;

  if (!subject) {
    for (const capability of ['READ_WORK_ITEM', 'READ_CLIENT', 'LIST_DOCUMENTS', 'DOWNLOAD_DOCUMENT']) {
      record(capability, 'SKIP', 'no work item available; name one with --work-item followed by its key');
    }
  } else {
    if (!workItemKey) {
      // Reading back a key the search has just returned. "Not found" here is
      // not an empty tenant — it means the key the search reports is not the
      // one the read endpoint accepts, which would break every feature that
      // looks a work item up by key.
      const readBack = await attempt(
        'READ_WORK_ITEM',
        () => client.getWorkItem(subject.workItemKey),
        (item) => (item ? `"${item.title}"` : `key ${subject.workItemKey} came from the search but does not resolve on read`),
        (item) => item !== null,
      );

      if (!readBack) {
        process.stdout.write(
          [
            '',
            'READ_WORK_ITEM failed in the way that matters: the search returned this work',
            `item, but GET /WorkItems/${subject.workItemKey} does not find it. Every feature`,
            'that resolves a work item by key depends on this, so it is worth settling before',
            'anything else. Most likely the field this client reads as the key is not the one',
            'the read endpoint expects.',
            '',
            'What the search actually returned for this work item:',
            '',
            ...describeKeyFields(subject.raw as Record<string, unknown> | undefined),
            '',
          ].join('\n'),
        );

        // Rather than print the candidates and wait for somebody to relay them,
        // try them. Each is a single read against a tenant this run is already
        // reading, and one run then answers the question outright instead of
        // starting a round trip.
        const working = await findWorkingKeyField(client, subject.raw as Record<string, unknown> | undefined);
        process.stdout.write(
          working
            ? `  The read endpoint accepts the value of "${working}". That is the field this\n` +
                '  client should read as the work item key — a one-line change.\n\n'
            : '  None of those values resolve on the read endpoint either, so the key is not\n' +
                '  the problem: the single-work-item read is unavailable to this API key, or is\n' +
                '  not served by this tenant. Worth raising with Karbon rather than changing.\n\n',
        );
      }
    }

    if (subject.clientKey) {
      await attempt(
        'READ_CLIENT',
        () => client.getClient(subject.clientKey as string),
        (found) => (found ? `${found.legalName} (${found.entityType})` : 'no organisation or contact matched that key'),
        (found) => found !== null,
      );
    } else {
      record('READ_CLIENT', 'SKIP', 'the work item carries no client key');
    }

    const documents = await attempt(
      'LIST_DOCUMENTS',
      () => client.listDocuments({ workItemKey: subject.workItemKey }),
      (list) => `${list.length} document(s)`,
    );

    // Look past the first work item when it has nothing attached. Giving up
    // there left the download unverified for the commonest reason imaginable —
    // the newest work item in a tenant usually has no documents yet — and
    // asked whoever ran this to go and find a key by hand.
    // The scope travels with the document. Karbon's download is a two-step —
    // list the entity to get a short-lived token, then spend it — so knowing
    // the identifier is not enough; the download has to be able to ask the same
    // shelf the listing came off.
    type Carrier = {
      documentId: string;
      fileName: string;
      where: string;
      scope: { workItemKey?: string; entityKey?: string };
    };

    let carrier: Carrier | null =
      documents && documents.length > 0
        ? {
            documentId: documents[0]!.documentId,
            fileName: documents[0]!.fileName,
            where: `work item ${subject.workItemKey}`,
            scope: { workItemKey: subject.workItemKey },
          }
        : null;

    // A refusal and an empty shelf are not the same finding, and reporting the
    // first as the second is how a harness ends up certifying an integration
    // that does not work. Keep the first error so the skip can say which it was.
    let hunted = 0;
    let firstError: string | null = null;
    const documentsOn = async (scope: { workItemKey: string } | { entityKey: string }) => {
      hunted += 1;
      try {
        return await client.listDocuments(scope);
      } catch (error) {
        firstError ??= error instanceof Error ? error.message : String(error);
        return [];
      }
    };

    if (!carrier && !workItemKey && found) {
      for (const candidate of found) {
        if (candidate.workItemKey === subject.workItemKey) continue;

        const theirs = await documentsOn({ workItemKey: candidate.workItemKey });
        if (theirs.length > 0) {
          carrier = {
            documentId: theirs[0]!.documentId,
            fileName: theirs[0]!.fileName,
            where: `work item ${candidate.workItemKey}`,
            scope: { workItemKey: candidate.workItemKey },
          };
          break;
        }
      }
    }

    // Karbon holds documents in two places, and the application searches both:
    // on the work item, and on the client record itself. A firm that files
    // last year's letter against the client rather than the work item would
    // otherwise show nothing here while the real prior-year search found it
    // perfectly well — a verification saying "unsupported" about something that
    // works.
    if (!carrier) {
      // The named work item's own client comes first: someone who passed
      // --work-item is pointing at the engagement they care about, and the
      // letter is more likely filed against that client than any other.
      const clientKeys = [
        ...new Set([subject.clientKey, ...(found ?? []).map((item) => item.clientKey)].filter((key): key is string => Boolean(key))),
      ];

      for (const entityKey of clientKeys.slice(0, CANDIDATE_LIMIT)) {
        const theirs = await documentsOn({ entityKey });
        if (theirs.length > 0) {
          carrier = {
            documentId: theirs[0]!.documentId,
            fileName: theirs[0]!.fileName,
            where: `client ${entityKey}`,
            scope: { entityKey },
          };
          record('LIST_DOCUMENTS_FOR_CLIENT', 'PASS', `${theirs.length} document(s) on client ${entityKey}`);
          break;
        }
      }

      if (!carrier && clientKeys.length > 0) {
        record(
          'LIST_DOCUMENTS_FOR_CLIENT',
          firstError ? 'FAIL' : 'SKIP',
          firstError
            ? `listing documents by client was refused: ${firstError}`
            : `no documents on any of ${clientKeys.length} client record(s) either`,
        );
      }
    }

    if (carrier) {
      const found = carrier;
      await attempt(
        'DOWNLOAD_DOCUMENT',
        () => client.downloadDocument(found.documentId, found.scope),
        (file) => `${file.fileName}, ${file.content.byteLength} bytes, ${file.mimeType} (from ${found.where})`,
      );
    } else {
      record(
        'DOWNLOAD_DOCUMENT',
        'SKIP',
        firstError
          ? `searched ${hunted} work item(s) and client record(s); at least one listing was refused (${firstError}), so "no documents" here is not trustworthy`
          : `searched ${hunted + 1} work item(s) and client record(s) and none carries a document`,
      );

      // Zero documents everywhere is implausible for a working firm, and the
      // list alone cannot tell "none attached" from "your API key cannot read
      // documents". Ask the endpoints what they actually said.
      if (!firstError && client instanceof KarbonRestClient) {
        process.stdout.write('\nWhat the document endpoints actually answered:\n\n');
        process.stdout.write(`${await client.describeDocumentAccess({ workItemKey: subject.workItemKey })}\n`);
        if (subject.clientKey) {
          process.stdout.write(`${await client.describeDocumentAccess({ entityKey: subject.clientKey })}\n`);
        }
        process.stdout.write(
          '\n200 with 0 documents means there genuinely are none there. A 404 means the\n' +
            'collection is not reachable — usually an API key without document scope — and\n' +
            'the zero above is not a fact about the firm at all.\n',
        );
      }

      // A real key from this tenant, so the suggestion can be pasted. Written
      // as `--work-item <KEY>` it could not: angle brackets are shell
      // redirection, and the shell answers "syntax error near unexpected
      // token" before the script ever runs.
      if (!firstError) {
        process.stdout.write(
          [
            '',
            'Nothing was attached to any of the work items or clients that were searched,',
            'which is ordinary for recent work. To verify the download, open a prior-year',
            'work item in Karbon that has the engagement letter attached, take the key from',
            'its URL, and run:',
            '',
            `  pnpm verify:karbon --work-item ${subject.workItemKey}`,
            '',
            '(that key is a real one from this tenant, so the command runs as written —',
            'substitute the key of a work item you know has an attachment)',
            '',
          ].join('\n'),
        );
      }
    }
  }

  // ---- Writes -------------------------------------------------------------
  if (!allowWrites) {
    for (const capability of ['ADD_COMMENT', 'UPLOAD_DOCUMENT', 'UPDATE_WORK_ITEM_STATUS']) {
      record(capability, 'SKIP', 'read-only run');
    }
    // Not a consequence of this being read-only: there is no task endpoint to
    // call in either mode. Saying "read-only run" would imply a write run would
    // exercise it.
    record('CREATE_TASK', 'SKIP', 'Karbon publishes no task-creation operation; the review note carries the assignment');
    return;
  }

  if (!subject) {
    for (const capability of ['ADD_COMMENT', 'CREATE_TASK', 'UPLOAD_DOCUMENT', 'UPDATE_WORK_ITEM_STATUS']) {
      record(capability, 'SKIP', 'no work item to write to');
    }
    return;
  }

  const stamp = new Date().toISOString();

  const comment = await attempt(
    'ADD_COMMENT',
    () =>
      client.addComment({
        workItemKey: subject.workItemKey,
        body: `Element Engagements verification run at ${stamp}. This note was posted by a test and can be deleted.`,
        idempotencyKey: `verify_comment_${stamp}`,
      }),
    (result) => `${result.outcome}${result.objectId ? ` (${result.objectId})` : ''}`,
  );

  // A note is rejected for exactly one reason in practice: the author is not a
  // user on this tenant. Rather than say so and stop, show the addresses that
  // would work — the answer and the way to apply it, in the same run.
  if (comment === null && client instanceof KarbonRestClient) {
    process.stdout.write(
      `\n  ADD_COMMENT failed. Karbon requires every note to name an author who is a\n` +
        `  user on this tenant, and refuses any other address.\n\n` +
        `  KARBON_NOTE_AUTHOR_EMAIL is currently ${process.env.KARBON_NOTE_AUTHOR_EMAIL?.trim() || 'unset (the first user Karbon lists is used)'}.\n`,
    );

    const users = await client.listUsers().catch(() => null);
    if (users && users.length > 0) {
      process.stdout.write('\n  Addresses Karbon will accept as the author:\n\n');
      for (const user of users) process.stdout.write(`    ${user.email.padEnd(40)} ${user.name}\n`);
      process.stdout.write(
        '\n  Set KARBON_NOTE_AUTHOR_EMAIL to one of these on both services, then re-run.\n\n',
      );
    } else {
      process.stdout.write(
        '\n  The user list could not be read either, so this API key may not be permitted\n' +
          '  to read users — which would also explain the refusal. Worth raising with Karbon.\n\n',
      );
    }
  }

  // Nothing to attempt. Karbon publishes no task-creation operation — this run
  // used to POST to `/WorkItems/{key}/Tasks`, read the 404 as "this tenant does
  // not have tasks", and report a tenant limitation that was really a wrong
  // path. Writing to a work item to learn something already settled by reading
  // the vendor's specification is not verification.
  record(
    'CREATE_TASK',
    'SKIP',
    'not attempted: Karbon publishes no task-creation operation, so the review note carries the assignment',
  );

  // The one that matters most. UPLOAD_DOCUMENT is how a signed engagement
  // letter reaches the client's permanent file — it is the last step of the
  // signing workflow and the only copy that outlives this application's own
  // scratch space. Leaving it "verify deliberately" meant it was never
  // verified at all, which is the weakest link left in the Karbon integration.
  //
  // The file is a valid, tiny PDF, named so nobody mistakes it for a client
  // document.
  const marker = `Element Engagements verification ${stamp}`;
  const testPdf = minimalPdf(marker);

  await attempt(
    'UPLOAD_DOCUMENT',
    () =>
      client.uploadDocument({
        workItemKey: subject.workItemKey,
        fileName: `ELEMENT ENGAGEMENTS VERIFICATION - SAFE TO DELETE.pdf`,
        content: testPdf,
        mimeType: 'application/pdf',
        idempotencyKey: `verify_upload_${stamp}`,
        // Nothing here should ever replace a document already in a client's
        // file, whatever it happens to be called.
        neverOverwrite: true,
      }),
    (result) => `${result.outcome}${result.objectId ? ` (${result.objectId})` : ''}${result.message ? ` — ${result.message}` : ''}`,
  );

  record(
    'UPDATE_WORK_ITEM_STATUS',
    'SKIP',
    'not attempted: status values are tenant-specific and changing one alters real workflow state',
  );

  process.stdout.write(
    `\nTest data was written to work item ${subject.workItemKey}. Delete the note and\n` +
      'the document named "ELEMENT ENGAGEMENTS VERIFICATION" when you are done.\n',
  );
}

/**
 * The smallest thing Karbon will accept as a PDF.
 *
 * Written by hand rather than generated, because a verification run must not
 * depend on the template engine or LibreOffice being available — and because a
 * few hundred bytes is the right size for something that will be deleted.
 */
function minimalPdf(text: string): Buffer {
  const escaped = text.replace(/[()\\]/g, '\\$&');
  const body = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
    `4 0 obj<</Length ${44 + escaped.length}>>stream`,
    `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`,
    'endstream endobj',
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
    'trailer<</Root 1 0 R/Size 6>>',
    '%%EOF',
  ].join('\n');
  return Buffer.from(body, 'latin1');
}

/**
 * The identifier-shaped fields of a raw work item, and nothing else.
 *
 * Deliberately not a dump of the record. A Karbon work item carries client
 * names, assignees and job details, and a verification run pasted into a chat
 * or an issue must not carry a firm's client data with it. Field *names* are
 * listed in full because the missing key might be any of them; values are shown
 * only for fields whose name marks them as an identifier.
 */
function describeKeyFields(raw: Record<string, unknown> | undefined): string[] {
  if (!raw) return ['  (the search result carried no raw record)'];

  const names = Object.keys(raw);
  const identifiers = names.filter((name) => /(^|[a-z])(key|id)$/i.test(name));

  const lines = [`  fields present: ${names.join(', ')}`, ''];

  if (identifiers.length === 0) {
    lines.push('  no field name looks like an identifier, which is itself the answer.');
    return lines;
  }

  for (const name of identifiers) {
    const value = raw[name];
    lines.push(`  ${name.padEnd(24)} ${typeof value === 'object' ? '(nested)' : String(value)}`);
  }
  return lines;
}

/**
 * Which identifier-shaped field, if any, the read endpoint actually accepts.
 *
 * Read-only and bounded: a handful of GETs against work items this run has
 * already listed. Cheap enough to be worth doing automatically, and it converts
 * "send me the field names and I will tell you" into an answer.
 */
async function findWorkingKeyField(
  client: KarbonProvider,
  raw: Record<string, unknown> | undefined,
): Promise<string | null> {
  if (!raw) return null;

  const candidates = Object.keys(raw).filter(
    (name) => /(^|[a-z])(key|id)$/i.test(name) && typeof raw[name] === 'string' && (raw[name] as string).length > 0,
  );

  for (const name of candidates) {
    const found = await client.getWorkItem(raw[name] as string).catch(() => null);
    if (found) return name;
  }
  return null;
}

function summarise(): void {
  const passed = results.filter((r) => r.outcome === 'PASS').length;
  const failed = results.filter((r) => r.outcome === 'FAIL').length;
  const skipped = results.filter((r) => r.outcome === 'SKIP').length;

  process.stdout.write(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);

  if (failed > 0) {
    process.stdout.write('\nA failure here is information, not necessarily a defect: it may mean the\n');
    process.stdout.write('operation is genuinely unavailable on this tenant. Record it as UNSUPPORTED\n');
    process.stdout.write('with its fallback rather than leaving it UNVERIFIED.\n');
  }

  process.stdout.write('\nNext: update packages/integrations/src/karbon/capabilities.ts and\n');
  process.stdout.write('docs/karbon-capability-matrix.md from what you just saw. A row stays\n');
  process.stdout.write('UNVERIFIED until it has been observed working here.\n\n');

  // A failed operation is a finding to record, not a broken script.
  process.exitCode = results.some((r) => r.capability === 'HEALTH_CHECK' && r.outcome === 'FAIL') ? 1 : 0;
}

function fail(message: string, remedy: string): never {
  process.stderr.write(`\n${message}\n${remedy}\n\n`);
  process.exit(1);
}

// A database failure here is almost always "wrong service" or "not migrated
// yet", and letting it throw prints the Prisma runtime before the one sentence
// that matters.
await main().catch((error: unknown) => {
  const problem = describeDatabaseProblem(error);
  process.stderr.write(
    problem ? `\n${formatDatabaseProblem(problem)}\n` : `\n${error instanceof Error ? error.message : String(error)}\n\n`,
  );
  process.exit(1);
});
