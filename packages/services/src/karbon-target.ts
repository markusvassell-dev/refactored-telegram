import type { KarbonUploadTarget } from '@element/integrations';

/**
 * Where a client's documents belong in Karbon: on the client, not on a job.
 *
 * A work item is a year's work; the client's Documents tab is the client's
 * permanent file. Signed letters, cover letters and the completion package are
 * records of the relationship, so they file against the entity — and the
 * entity's *kind* is part of the address: Karbon links files through
 * `organization_keys` or `contact_keys`, and the wrong one attaches the file
 * to the wrong record without an error.
 *
 * Returns a reason instead of throwing, because every caller has the same
 * choice to make: an engagement whose client is not linked to Karbon can still
 * finish — the file is kept here and the gap is reported — and a thrown error
 * would dead-letter the job and block completion instead.
 */
export type ClientUploadTarget =
  | { ok: true; target: KarbonUploadTarget; entityKey: string }
  | { ok: false; unavailable: string };

export function clientUploadTarget(client: {
  legalName: string;
  karbonEntityKey: string | null;
  karbonEntityType: string | null;
}): ClientUploadTarget {
  if (!client.karbonEntityKey) {
    return {
      ok: false,
      unavailable: `${client.legalName} is not linked to a Karbon record, so nothing can be filed to their Documents tab. Import the client from Karbon to link them.`,
    };
  }

  if (client.karbonEntityType !== 'Organization' && client.karbonEntityType !== 'Contact') {
    return {
      ok: false,
      unavailable: `${client.legalName}'s Karbon record kind is ${client.karbonEntityType ? `"${client.karbonEntityType}"` : 'not recorded'}, so the file cannot be linked to their Documents tab. Re-import the client from Karbon so the record kind is known.`,
    };
  }

  return {
    ok: true,
    target: { entityKey: client.karbonEntityKey, entityType: client.karbonEntityType },
    entityKey: client.karbonEntityKey,
  };
}
