import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * What the Karbon webhook receiver assumes, written down where it can be checked.
 *
 * There is no equivalent of `adobe-webhook-shape.test.ts` for Karbon, and the
 * reason is worse than an oversight: **nothing about this receiver has been
 * verified against Karbon's specification.** The header name it reads, the HMAC
 * scheme it verifies with and the four payload fields it parses were all
 * inferred. Nothing subscribes to Karbon's webhooks either, so not one request
 * has ever arrived to disagree.
 *
 * That combination is exactly what produced the Adobe defect this file is
 * modelled on: a shape mismatch yields nulls, the event is discarded as
 * unhandled, and the endpoint returns 200 every time. Silence that looks like
 * success.
 *
 * So these assertions do not claim the shape is right. They pin what the code
 * currently believes, so that checking it against Karbon's published
 * documentation is a matter of reading one file — and so that changing the
 * belief is a deliberate act with a test to update rather than a quiet edit.
 *
 * **Before relying on the webhook in production**, confirm each item below
 * against Karbon's own documentation and register a `Work` subscription.
 * Until then the scheduled poll is what actually drives rollover, and it uses
 * `searchWorkItems`, which has been exercised against the live tenant.
 */

const ROUTE = 'apps/web/src/app/api/webhooks/karbon/route.ts';

async function route(): Promise<string> {
  return readFile(join(process.cwd(), ROUTE), 'utf8');
}

describe('the Karbon webhook receiver, as currently written', () => {
  it('reads the signature from x-karbon-signature', async () => {
    // Unverified. Karbon may name this header something else entirely, in which
    // case every delivery is refused with a 400 and nothing says why.
    expect(await route()).toContain("request.headers.get('x-karbon-signature')");
  });

  it('refuses every request until a secret is configured', async () => {
    // A 503 rather than a silent accept, so an unconfigured receiver is visible
    // from the vendor's side rather than looking like it worked.
    const source = await route();
    expect(source).toContain('KARBON_WEBHOOK_SECRET');
    expect(source).toContain('503');
  });

  it('parses the four fields it acts on, in both casings', async () => {
    const source = await route();

    for (const field of ['EventId', 'WorkItemKey', 'WorkStatus', 'WorkType']) {
      expect(source, `the receiver no longer reads ${field}`).toContain(field);
      // Karbon's OData surface is PascalCase; the camelCase alternates are a
      // hedge against a webhook payload that does not follow it.
      expect(source).toContain(`${field.charAt(0).toLowerCase()}${field.slice(1)}`);
    }
  });

  it('refuses an event carrying no work item, rather than guessing', async () => {
    const source = await route();
    expect(source).toContain('The event carried no work item.');
  });

  it('acts only on a configured status, never on a comment', async () => {
    // The rule that keeps a vendor event a hint rather than an instruction. A
    // work item status change may start an engagement; nothing else may.
    const source = await route();
    expect(source).toContain('karbonStatusTriggers()');
    expect(source).toContain("jobType: 'ROLL_OVER_ENGAGEMENT'");
  });

  it('does not end the request early on a redelivered event', async () => {
    // It used to. That was safe while the only work below was a search that
    // would be repeated anyway; it is not safe now that the work below decides
    // whether an engagement is created. Deduplication belongs on each enqueue,
    // which has a deterministic key, rather than on the delivery.
    const source = await route();
    const beforeTriggers = source.slice(0, source.indexOf('karbonStatusTriggers()'));
    expect(beforeTriggers).not.toContain('return NextResponse.json({ accepted: true, duplicate: true');
  });
});
