/**
 * Encoding of a storage reference for use in a URL path segment.
 *
 * A reference contains slashes, so it cannot be dropped into a path as-is.
 * Both the link builder and the download route go through this module so the
 * two sides cannot drift apart: a mismatch would either break every link or,
 * worse, produce a signature computed over a different string than the one
 * verified.
 *
 * Deliberately kept free of any container or database import so it stays
 * cheap to import and straightforward to test.
 */

export function encodeReference(reference: string): string {
  return encodeURIComponent(Buffer.from(reference, 'utf8').toString('base64url'));
}

export function decodeReference(encoded: string): string {
  return Buffer.from(decodeURIComponent(encoded), 'base64url').toString('utf8');
}
