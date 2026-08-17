import Link from 'next/link';
import type { ReactNode } from 'react';
import { splitEntityName } from '@element/integrations';
import { ActionForm } from '@/components/action-form';
import { adoptKarbonLegalName } from '@/app/actions';

/**
 * Who a client is, in one description used everywhere a client is identified.
 *
 * The firm's clients are mostly numbered corporations, so "the client's name" is
 * two different strings depending on who is asking. The letter needs `2409116
 * Alberta Ltd.`, because that is the entity that signs it. A person needs `Lava
 * Grill Seton`, because that is the only name they have ever used for it. A
 * screen that shows one and not the other is unreadable to somebody, so this
 * shows both and says which is which.
 *
 * The third name is the important one. `karbonFullName` is what Karbon holds,
 * unsplit — and for a client stored here under the wrong name it is the *only*
 * record of the right one, because the import reports a difference and refuses
 * to overwrite. Showing it is what turns "this looks wrong" into "this is wrong,
 * and here is the correct value".
 */

export interface ClientIdentity {
  id: string;
  legalName: string;
  displayName: string | null;
  karbonFullName: string | null;
  karbonContactType: string | null;
  karbonNameSyncedAt: Date | null;
  karbonEntityKey: string | null;
  karbonEntityType: string | null;
  businessNumber: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  isTestFixture: boolean;
}

/**
 * The legal name Karbon implies, when it is not the one stored here.
 *
 * Split with the same function the import uses, deliberately: if the card
 * separated names by its own rule the two would disagree about what counts as a
 * difference, and a screen that reports a mismatch the import will not act on is
 * worse than no screen.
 */
export function karbonNameDisagreement(
  client: Pick<ClientIdentity, 'legalName' | 'karbonFullName'>,
): { legalName: string; tradeName: string | null } | null {
  if (!client.karbonFullName) return null;
  const split = splitEntityName(client.karbonFullName);
  if (split.legalName === client.legalName) return null;
  return split;
}

function formatAddress(client: ClientIdentity): string {
  const lines = [
    client.addressLine1,
    client.addressLine2,
    [client.city, client.province].filter(Boolean).join(', '),
    client.postalCode,
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);

  return lines.length > 0 ? lines.join(' · ') : '—';
}

function Detail({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div>
      <dt className="text-xs uppercase text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

export function ClientIdentityCard({
  client,
  counts,
  canCorrect,
  csrfToken,
  headingHref,
}: {
  client: ClientIdentity;
  counts?: { contacts?: number; documents?: number; engagements?: number };
  canCorrect: boolean;
  csrfToken: string;
  /** Set on the search result, where the name should lead to the full page. */
  headingHref?: string;
}): ReactNode {
  const disagreement = karbonNameDisagreement(client);
  const tradeName = client.displayName && client.displayName !== client.legalName ? client.displayName : null;

  return (
    <section className="card mb-6">
      <div className="card-header">
        <h2 className="text-lg font-semibold">
          {headingHref ? (
            <Link className="underline" href={headingHref}>
              {client.legalName}
            </Link>
          ) : (
            client.legalName
          )}
          {client.isTestFixture ? (
            <span className="badge ml-2 bg-amber-100 text-amber-800">test fixture</span>
          ) : null}
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          {tradeName ? (
            <>
              Trading as <strong>{tradeName}</strong>. The legal name above is the one that prints on an engagement
              letter.
            </>
          ) : (
            'The legal name above is the one that prints on an engagement letter.'
          )}
        </p>
      </div>

      <div className="card-body">
        {/*
          Stated before the details, because it changes what the details mean. A
          reader who does not know the stored legal name is wrong will read the
          rest of this card as confirmation.
        */}
        {disagreement ? (
          <div className="mb-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
            <p className="font-medium text-amber-900">Karbon does not call this client what we do.</p>
            <dl className="mt-2 grid gap-2 sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase text-amber-800">Stored here, and what would print</dt>
                <dd className="font-medium text-amber-900">{client.legalName}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-amber-800">Karbon&rsquo;s legal entity</dt>
                <dd className="font-medium text-amber-900">{disagreement.legalName}</dd>
              </div>
            </dl>
            <p className="mt-2 text-amber-900">
              The import never overwrites a name already held here, because somebody may have corrected one on purpose.
              If this one was not corrected on purpose, it is wrong on every letter this client signs.
            </p>
            {canCorrect ? (
              <div className="mt-3">
                <ActionForm
                  action={adoptKarbonLegalName}
                  csrfToken={csrfToken}
                  submitLabel={`Use “${disagreement.legalName}” as the legal name`}
                  variant="secondary"
                  confirm={`This replaces the legal name “${client.legalName}” with “${disagreement.legalName}” on every future letter for this client. Continue?`}
                >
                  <input type="hidden" name="clientId" value={client.id} />
                </ActionForm>
              </div>
            ) : (
              <p className="mt-2 text-amber-900">
                Correcting a legal name needs the reviewer role or higher, because it is what prints on a signed
                document.
              </p>
            )}
          </div>
        ) : null}

        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Detail label="Legal name">{client.legalName}</Detail>
          <Detail label="Trade name">{tradeName ?? <span className="text-slate-500">—</span>}</Detail>
          <Detail label="Karbon calls it">
            {client.karbonFullName ? (
              <>
                {client.karbonFullName}
                <span className="mt-0.5 block text-xs text-slate-500">
                  {client.karbonNameSyncedAt
                    ? `read from Karbon ${client.karbonNameSyncedAt.toISOString().slice(0, 10)}`
                    : 'date unknown'}
                </span>
              </>
            ) : (
              /*
                Absence is not "Karbon has no name for it" — it is that no import
                has read this client since the name started being kept. Saying
                which is the difference between a shrug and an instruction.
              */
              <span className="text-slate-500">
                not read yet — run the import to fill this in
              </span>
            )}
          </Detail>
          <Detail label="Karbon record">
            {client.karbonEntityKey ? (
              <span className="font-mono text-xs">
                {client.karbonEntityKey}
                <span className="ml-2 font-sans text-slate-500">{client.karbonEntityType}</span>
              </span>
            ) : (
              <span className="text-slate-500">not linked</span>
            )}
          </Detail>
          <Detail label="Karbon contact type">
            {client.karbonContactType ?? <span className="text-slate-500">—</span>}
          </Detail>
          <Detail label="Business number">{client.businessNumber ?? <span className="text-slate-500">—</span>}</Detail>
          <Detail label="Address">{formatAddress(client)}</Detail>
          {counts ? (
            <Detail label="Held here">
              {[
                counts.contacts === undefined ? null : `${counts.contacts} contact(s)`,
                counts.documents === undefined ? null : `${counts.documents} document(s)`,
                counts.engagements === undefined ? null : `${counts.engagements} engagement(s)`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Detail>
          ) : null}
        </dl>
      </div>
    </section>
  );
}
