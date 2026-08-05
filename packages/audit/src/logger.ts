import { type Prisma, type PrismaClient } from '@element/database';
import { newCorrelationId, redact } from '@element/shared';

/**
 * The audit trail.
 *
 * Audit events are append-only. The database rejects UPDATE and DELETE on the
 * table outright, so there is no code path — in this application or any other —
 * that can rewrite history.
 *
 * Before and after values are redacted before storage: the audit trail records
 * that a fee changed and by how much, not a client's social insurance number.
 */

export const AUDIT_EVENT_TYPES = [
  'USER_LOGIN',
  'USER_LOGIN_FAILED',
  'USER_LOGOUT',
  'ENGAGEMENT_CREATED',
  'GENERATION_REQUESTED',
  'SOURCE_DOCUMENT_SELECTED',
  'FIELD_EXTRACTED',
  'CONFLICT_RESOLVED',
  'FEE_CALCULATED',
  'FEE_OVERRIDDEN',
  'DATE_CALCULATED',
  'DATE_CONFIRMED',
  'FIELD_EDITED',
  'WORDING_EDITED',
  'REVIEW_COMMENT_ADDED',
  'APPROVAL_GRANTED',
  'APPROVAL_REJECTED',
  'CHANGES_REQUESTED',
  'ADOBE_AGREEMENT_SENT',
  'ADOBE_SIGNER_CHANGED',
  'ADOBE_SIGNING_EVENT',
  'KARBON_UPLOAD',
  'KARBON_COMMENT',
  'KARBON_TASK',
  'STATUS_CHANGED',
  'COVER_LETTER_GENERATED',
  'COVER_LETTER_EDITED',
  'COVER_LETTER_APPROVED',
  'COVER_LETTER_MARKED_STALE',
  'JOB_FAILED',
  'JOB_RETRIED',
  'CONFIGURATION_CHANGED',
  'TEMPLATE_ACTIVATED',
  'TEMPLATE_RETIRED',
  'TEST_MODE_CHANGED',
  'PRODUCTION_SENDING_CHANGED',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export interface AuditEntry {
  eventType: AuditEventType;
  objectType: string;
  objectId?: string | null;
  userId?: string | null;
  engagementId?: string | null;
  beforeValue?: unknown;
  afterValue?: unknown;
  reason?: string | null;
  correlationId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuditLogger {
  record(entry: AuditEntry): Promise<void>;
  /** Records several events atomically with a shared correlation id. */
  recordMany(entries: readonly AuditEntry[], correlationId?: string): Promise<void>;
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return redact(value) as Prisma.InputJsonValue;
}

export function createAuditLogger(prisma: PrismaClient): AuditLogger {
  async function write(entries: readonly AuditEntry[], sharedCorrelationId?: string): Promise<void> {
    if (entries.length === 0) return;

    const correlationId = sharedCorrelationId ?? newCorrelationId();

    await prisma.auditEvent.createMany({
      data: entries.map((entry) => ({
        eventType: entry.eventType,
        objectType: entry.objectType,
        objectId: entry.objectId ?? null,
        userId: entry.userId ?? null,
        engagementId: entry.engagementId ?? null,
        beforeValue: toJson(entry.beforeValue),
        afterValue: toJson(entry.afterValue),
        reason: entry.reason ?? null,
        correlationId: entry.correlationId ?? correlationId,
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
      })),
    });
  }

  return {
    record: (entry) => write([entry], entry.correlationId ?? undefined),
    recordMany: (entries, correlationId) => write(entries, correlationId),
  };
}

/** Collects audit entries during a unit of work and flushes them together. */
export class AuditBuffer {
  private readonly entries: AuditEntry[] = [];

  constructor(
    private readonly logger: AuditLogger,
    readonly correlationId: string = newCorrelationId(),
  ) {}

  add(entry: AuditEntry): void {
    this.entries.push({ ...entry, correlationId: entry.correlationId ?? this.correlationId });
  }

  get size(): number {
    return this.entries.length;
  }

  async flush(): Promise<void> {
    if (this.entries.length === 0) return;
    const pending = this.entries.splice(0, this.entries.length);
    await this.logger.recordMany(pending, this.correlationId);
  }
}
