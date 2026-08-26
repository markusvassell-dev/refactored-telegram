import Link from 'next/link';
import { pageAccess, sessionCsrfToken } from '@/lib/session';
import { AccessDenied } from '@/components/access-denied';
import { PageHeader } from '@/components/shell';
import { ActionForm } from '@/components/action-form';
import { ClientDetailsFields } from '@/components/client-details-fields';
import { createClient } from '@/app/actions';

export const dynamic = 'force-dynamic';

/**
 * A client this application does not already hold.
 *
 * The import is the right way to add a client Karbon knows about, and it stays
 * the right way — it brings the entity key, the contacts and the name Karbon
 * uses, none of which can be typed correctly from memory. This is for the case
 * the import cannot serve at all: an entity the firm has just taken on, or one
 * Karbon has no record of.
 *
 * It says plainly what a client added here is missing, because the consequences
 * are quiet ones. No Karbon link means no document catalogue and no automatic
 * prior-year letter — and "the search found nothing" looks identical whether
 * the client has no history or has one this application cannot see.
 */
export default async function NewClientPage() {
  const access = await pageAccess('client:manage');
  if (!access.allowed) {
    return <AccessDenied permission="client:manage" user={access.user} what="adding a client" />;
  }

  const csrfToken = (await sessionCsrfToken()) ?? '';

  return (
    <>
      <PageHeader
        title="Add a client"
        description="For an entity Karbon has no record of. If Karbon holds this client, import them instead — the import brings their entity key, their contacts and the name Karbon uses, and none of those can be typed correctly from memory."
      />

      <section className="card mb-6">
        <div className="card-header">
          <h2 className="text-base font-semibold">What a client added here will not have</h2>
        </div>
        <div className="card-body">
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
            <li>
              <strong>No link to Karbon.</strong> Their documents cannot be catalogued and no prior-year letter will be
              found automatically. Both will report finding nothing, which looks the same as having no history.
            </li>
            <li>
              <strong>No contacts.</strong> Contacts come from Karbon, and an engagement letter needs somebody to
              address and somebody to sign. Add the signers on the engagement itself.
            </li>
            <li>
              A later import will fill any detail left blank here, and will never overwrite one that is filled in.
            </li>
          </ul>
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h2 className="text-base font-semibold">Details</h2>
          <p className="mt-1 text-sm text-slate-600">
            These print on the engagement letter, so the ones with a knowable shape are checked rather than stored as
            typed. A wrong value is worse than a blank one — blank is visibly missing, wrong passes review.
          </p>
        </div>
        <div className="card-body">
          <ActionForm action={createClient} csrfToken={csrfToken} submitLabel="Add this client">
            <ClientDetailsFields />
          </ActionForm>
        </div>
      </section>

      <p className="mt-6 text-sm">
        <Link className="underline" href="/clients">
          Back to clients
        </Link>
      </p>
    </>
  );
}
