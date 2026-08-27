import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { PricingService } from '@element/services';
import { PermissionError, type Principal } from '@element/shared';

/**
 * Nobody approves a fee they produced themselves.
 *
 * The application refuses this everywhere else without qualification — "nobody
 * approves the draft they themselves produced", the same for a wording change,
 * a template version and a cover letter. Fees were the exception: the check ran
 * only when `isManualOverride` was set.
 *
 * That made it weakest where it matters most. `calculatedByUserId` is written
 * on every calculation, so a partner who ran preparation from the web screen
 * and got back a high increase could approve it themselves, while the same
 * partner typing the same figure by hand was refused. The threshold exists to
 * put a large movement in front of a second person before a client sees it on a
 * letter, and the rule-derived increase is the one it exists for.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);
const service = new PricingService(prisma, audit);

const suffix = randomUUID().slice(0, 8);
const clientIds: string[] = [];
const userIds: string[] = [];

let partner: Principal;
let otherPartner: Principal;

async function makeUser(email: string, roles: Principal['roles']): Promise<Principal> {
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, displayName: email.split('@')[0] as string },
    update: {},
  });
  userIds.push(user.id);
  for (const role of roles) {
    await prisma.userRole.upsert({
      where: { userId_role: { userId: user.id, role } },
      create: { userId: user.id, role },
      update: {},
    });
  }
  return { id: user.id, email: user.email, displayName: user.displayName, roles };
}

beforeAll(async () => {
  await prisma.$connect();
  partner = await makeUser(`fee-partner-${suffix}@example.test`, ['PARTNER_OR_FINAL_APPROVER']);
  otherPartner = await makeUser(`fee-other-${suffix}@example.test`, ['PARTNER_OR_FINAL_APPROVER']);
});

afterAll(async () => {
  await prisma.engagement.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

let nextYear = 2800;

/** A fee awaiting approval, attributed to `calculatedBy`. */
async function aFeeAwaitingApproval(options: {
  calculatedBy: string | null;
  isManualOverride: boolean;
}): Promise<{ engagementId: string }> {
  const client = await prisma.client.create({
    data: { legalName: `Fee Co ${randomUUID().slice(0, 8)}`, isTestFixture: true },
  });
  clientIds.push(client.id);

  nextYear += 1;
  const engagement = await prisma.engagement.create({
    data: { clientId: client.id, engagementType: 'T2', taxYear: nextYear, isTestMode: true },
  });

  await prisma.feeCalculation.create({
    data: {
      engagementId: engagement.id,
      feeKind: 'T2_PREPARATION',
      method: 'PERCENTAGE',
      previousFee: '900',
      roundedFee: '1450',
      requiresApprovalType: 'FEE_HIGH_INCREASE',
      isManualOverride: options.isManualOverride,
      calculatedByUserId: options.calculatedBy,
    },
  });

  return { engagementId: engagement.id };
}

describe('approving a fee', () => {
  it('refuses the person who calculated it, even when they did not override it', async () => {
    // The case that used to be allowed. `isManualOverride` is false, which is
    // what a rule-derived high increase looks like.
    const { engagementId } = await aFeeAwaitingApproval({
      calculatedBy: partner.id,
      isManualOverride: false,
    });

    await expect(service.approveFee({ engagementId, feeKind: 'T2_PREPARATION', approver: partner })).rejects.toThrow(
      PermissionError,
    );
  });

  it('still refuses the person who overrode it', async () => {
    const { engagementId } = await aFeeAwaitingApproval({
      calculatedBy: partner.id,
      isManualOverride: true,
    });

    await expect(service.approveFee({ engagementId, feeKind: 'T2_PREPARATION', approver: partner })).rejects.toThrow(
      /cannot approve your own/i,
    );
  });

  it('allows a different partner', async () => {
    const { engagementId } = await aFeeAwaitingApproval({
      calculatedBy: partner.id,
      isManualOverride: false,
    });

    await service.approveFee({ engagementId, feeKind: 'T2_PREPARATION', approver: otherPartner });

    const stored = await prisma.feeCalculation.findFirstOrThrow({ where: { engagementId } });
    expect(stored.approvedByUserId).toBe(otherPartner.id);
  });

  it('leaves the ordinary worker-calculated fee approvable by anyone entitled', async () => {
    // Preparation runs as the system actor and `resolveUserActor` stores null,
    // so the guard has nobody to compare against. Nothing legitimate is blocked
    // by making the check unconditional — that is what makes it safe to do.
    const { engagementId } = await aFeeAwaitingApproval({
      calculatedBy: null,
      isManualOverride: false,
    });

    await service.approveFee({ engagementId, feeKind: 'T2_PREPARATION', approver: partner });

    const stored = await prisma.feeCalculation.findFirstOrThrow({ where: { engagementId } });
    expect(stored.approvedByUserId).toBe(partner.id);
  });
});
