/**
 * Log redaction.
 *
 * This application handles personal, corporate, trust and tax information.
 * Ordinary logs must never contain complete tax documents, social insurance
 * numbers, passwords, tokens, or confidential client data.
 */

const SECRET_KEY_PATTERN =
  /(pass(word)?|secret|token|api[-_]?key|authorization|cookie|session|bearer|credential|private[-_]?key|refresh[-_]?token|client[-_]?secret|encryption[-_]?key|signature)/i;

/** Keys whose values are client-identifying and must be masked, not dropped. */
const SENSITIVE_KEY_PATTERN =
  /(sin|social[-_]?insurance|business[-_]?number|bn|trust[-_]?account|email|phone|telephone|address|dob|date[-_]?of[-_]?birth|account[-_]?number)/i;

/** Free-text patterns that must never survive into a log line. */
const SIN_PATTERN = /\b\d{3}[-\s]?\d{3}[-\s]?\d{3}\b/g;
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

export const REDACTED = '[redacted]';

export function maskEmail(value: string): string {
  const at = value.indexOf('@');
  if (at <= 0) return REDACTED;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

/** Keeps only the last `visible` characters. Used for account/business numbers. */
export function maskTail(value: string, visible = 3): string {
  const trimmed = value.trim();
  if (trimmed.length <= visible) return '*'.repeat(trimmed.length);
  return `${'*'.repeat(trimmed.length - visible)}${trimmed.slice(-visible)}`;
}

export function redactText(input: string): string {
  return input
    .replace(BEARER_PATTERN, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(SIN_PATTERN, REDACTED)
    .replace(EMAIL_PATTERN, (m) => maskEmail(m));
}

/**
 * Deep-redacts an arbitrary value for logging.
 * Secrets are removed outright; client identifiers are masked.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[max-depth]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message) };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `[binary ${value.byteLength} bytes]`;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redact(item, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = REDACTED;
        continue;
      }
      if (SENSITIVE_KEY_PATTERN.test(key) && typeof raw === 'string') {
        out[key] = key.toLowerCase().includes('email') ? maskEmail(raw) : maskTail(raw);
        continue;
      }
      out[key] = redact(raw, depth + 1);
    }
    return out;
  }

  return '[unserialisable]';
}
