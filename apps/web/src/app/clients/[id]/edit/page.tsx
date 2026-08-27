import Link from 'next/link';
import { notFound } from 'next/navigation';
import { container } from '@/lib/container';
import { pageAccess, sessionCsrfToken } from '@/lib/session';
import { AccessDenied } from '@/components/access-denied';
import { PageHeader } from '@/components/shell';
import { ActionForm } from '@/components/action-form';
import { ClientDetailsFields } from '@/components/client-details-fields';
import { updateClient } from '@/app/actions';

export const dynamic = 'force-dynamic';

/**
 * Correcting the details this application holds for a client.
 *
 * The other route to a client's name is the one-click adopt on the client page,
 * which replaces the stored legal name with Karbon's. That remains the right
 * one whenever Karbon holds the correct value: it needs no typing and no
 * reason, because the before and the after are the whole explanation.
 *
 * This screen is for the value that is in neither place — and for the two
 * fields Karbon can never supply at all, a trust account number and a business
 * number Karbon does not record.
 */
export default async function EditClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await pageAccess('client:manage');
  if (!access.allowed) {
    return <AccessDenied permission="client:manage" user={access.user} what="editing a client" />;
  }

  const csrfToken = (await sessionCsrfToken()) ?? '';

  const client = await container.prisma.client.findUnique({
    where: { id },
    select: {
      id: true,
      legalName: true,
      displayName: true,
      businessNumber: true,
      trustAccountNumber: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      province: true,
      postalCode: true,
      country: true,
      clientGroup: true,
      karbonEntityKey: true,
      karbonEntityType: true,
      karbonFullName: true,
      karbonContactType: true,
      karbonNameSyncedAt: true,
    },
  });

  if (!client) notFound();

  return (
    <>
      <PageHeader
        title={`Edit ${client.legalName}`}
        description="These details print on the engagement letter. A later import will fill anything left blank here and will never overwrite anything filled in."
      />

      {/*
        Shown, and not editable.

        These columns record what Karbon said, not what anybody here chose —
        which is exactly what makes `karbonFullName` usable as evidence when the
        stored legal name is wrong. A field that mirrors a vendor and can also
        be typed over is no longer evidence of anything.
      */}
      <section className="card mb-6">
        <div className="card-header">
          <h2 className="text-base font-semibold">What Karbon says</h2>
          <p className="mt-1 text-sm text-slate-600">
            Read-only on purpose. These record what the vendor holds, which is what makes them usable as evidence when
            a stored value is wrong. Change them by importing from Karbon.
          </p>
        </div>
        <div className="card-body">
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-xs uppercase text-slate-500">Karbon calls it</dt>
              <dd className="mt-0.5 text-sm">
                {client.karbonFullName ?? <span className="text-slate-500">not read yet</span>}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-500">Karbon record</dt>
              <dd className="mt-0.5 text-sm">
                {client.karbonEntityKey ? (
                  <span className="font-mono text-xs">
                    {client.karbonEntityKey}
                    <span className="ml-2 font-sans text-slate-500">{client.karbonEntityType}</span>
                  </span>
                ) : (
                  <span className="text-slate-500">not linked — added by hand</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-slate-500">Last read from Karbon</dt>
              <dd className="mt-0.5 text-sm">
                {client.karbonNameSyncedAt ? (
                  client.karbonNameSyncedAt.toISOString().slice(0, 10)
                ) : (
                  <span className="text-slate-500">never</span>
                )}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h2 className="text-base font-semibold">Details</h2>
        </div>
        <div className="card-body">
          <ActionForm
            action={updateClient}
            csrfToken={csrfToken}
            submitLabel="Save these details"
            confirm={`This changes the details that print on every future letter for ${client.legalName}. Continue?`}
          >
            <input type="hidden" name="clientId" value={client.id} />

            <ClientDetailsFields values={client} />

            {/*
              Required only when the legal name moves, and the service enforces
              that rather than this markup. Demanding a sentence to fix a
              postcode would be friction that teaches people to type "." into
              reason boxes, which costs the trail more than it gains.
            */}
            <div className="mt-6 border-t border-slate-200 pt-4">
              <label className="label" htmlFor="client-reason">
                Reason
                <span className="ml-1 font-normal text-slate-500">
                  (required only if you are changing the legal name)
                </span>
              </label>
              <textarea
                id="client-reason"
                name="reason"
                className="input"
                rows={2}
                placeholder="Amalgamated with 2140071 Alberta Ltd. on 1 July"
              />
              <p className="field-note">
                The legal name is what prints on every letter this client signs, so a change to it has to say why. An
                existing draft keeps the old name until it is regenerated.
              </p>
            </div>
          </ActionForm>
        </div>
      </section>

      <p className="mt-6 text-sm">
        <Link className="underline" href={`/clients/${client.id}`}>
          Back to {client.legalName}
        </Link>
      </p>
    </>
  );
}
