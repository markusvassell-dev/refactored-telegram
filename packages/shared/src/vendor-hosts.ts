/**
 * Whether a vendor base URL is a production host.
 *
 * The sandbox flag on an integration connection is what Test Mode keys off:
 * with Test Mode on, a connection marked production is replaced by an adapter
 * that cannot reach the vendor at all. That is a structural guarantee — until
 * somebody marks a production connection "Sandbox", at which point it is a
 * label, and the guarantee is gone.
 *
 * That is not a hypothetical misuse. Karbon publishes no separate sandbox host:
 * `api.karbonhq.com` is the only one there is. So a firm that wants the
 * application to use Karbon at all while Test Mode is on has exactly one way to
 * get there, and it is to tick the wrong box. The application cannot fix the
 * vendor's lack of a sandbox, but it can refuse to let a mislabel pass
 * unremarked.
 */

/** Hosts known to be production, per vendor. */
const PRODUCTION_HOSTS: Record<string, readonly string[]> = {
  KARBON: ['api.karbonhq.com'],
  // Adobe genuinely does offer separate accounts, so a shard host says nothing
  // about whether it is a sandbox or a production account.
  ADOBE_SIGN: [],
};

export function isKnownProductionHost(provider: string, baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;

  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }

  return (PRODUCTION_HOSTS[provider] ?? []).includes(hostname);
}

/**
 * Names the mismatch between a connection's label and where it points, or
 * returns null when there is nothing to say. The wording reaches an operator.
 */
export function describeSandboxMislabel(input: {
  provider: string;
  baseUrl: string | null | undefined;
  isSandbox: boolean;
}): string | null {
  if (!input.isSandbox) return null;
  if (!isKnownProductionHost(input.provider, input.baseUrl)) return null;

  return (
    `This connection is marked Sandbox but points at ${input.baseUrl}, which is production. ` +
    'Under Test Mode a production connection is used for reads only and every write is refused; a production ' +
    'connection labelled Sandbox skips that, so a write could reach a real client record while the application ' +
    'still says TEST MODE. Karbon publishes no sandbox host, so the honest setting is Production — and with it ' +
    'the client list and prior-year documents still work, which is what marking it Sandbox was for.'
  );
}
