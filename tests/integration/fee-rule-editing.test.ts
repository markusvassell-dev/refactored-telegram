import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { calculateFee, resolveRule } from '@element/pricing';
import { FeeRuleService } from '@element/services';

/**
 * Editing a pricing rule.
 *
 * Two failure modes drive these tests, and both are silent in production: a
 * rule scoped to nothing never matches anything, and a method with no value
 * produces no fee. Neither announces itself — the engagement simply stays
 * blocked and nobody knows why. The third property is that an approved fee is a
 * decision about a specific number and is never revisited.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);
const feeRules = new FeeRuleService({ prisma, audit });

let actorId: string;
let clientId: string;
const ruleIds: string[] = [];

const TAX_YEAR = 2026;

beforeAll(async () => {
  await prisma.$connect();

  const actor = await prisma.user.upsert({
    where: { email: 'fee-rule-test@example.test' },
    create: { email: 'fee-rule-test@example.test', displayName: 'Fee Rule Test' },
    update: {},
  });
  actorId = actor.id;

  const client = await prisma.client.create({
    data: { legalName: `Fee Rule Co ${randomUUID().slice(0, 8)}`, isTestFixture: true },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.feeCalculation.deleteMany({ where: { feeRuleId: { in: ruleIds } } });
  await prisma.engagement.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.feeRule.deleteMany({ where: { id: { in: ruleIds } } });
  await prisma.$disconnect();
});

function save(overrides: Record<string, unknown> = {}) {
  return feeRules.save({
    actorId,
    reason: 'The firm set its increase for the new year.',
    level: 'ENGAGEMENT_TYPE',
    engagementType: 'T2',
    feeKind: 'T2_PREPARATION',
    method: 'PERCENTAGE',
    percentage: '4',
    skipRounding: false,
    appliesToAncillaryCharges: false,
    isActive: true,
    ...overrides,
  } as Parameters<FeeRuleService['save']>[0]);
}

async function newRule(overrides: Record<string, unknown> = {}): Promise<string> {
  const result = await save(overrides);
  ruleIds.push(result.id);
  return result.id;
}

describe('creating a rule', () => {
  it('stores it, and the pricing engine then produces its number', async () => {
    const id = await newRule({ percentage: '4' });

    const rule = await feeRules.get(id);
    expect(rule.method).toBe('PERCENTAGE');
    expect(Number(rule.percentage)).toBe(4);
    expect(rule.isActive).toBe(true);

    // $2,000 + 4% = $2,080, already a multiple of five.
    const calculated = calculateFee({
      feeKind: 'T2_PREPARATION',
      rule: { method: rule.method, percentage: rule.percentage, skipRounding: rule.skipRounding },
      previousFee: '2000',
      highIncreaseThresholdPercent: 10,
    });

    expect(calculated.roundedFee?.toFixed(2)).toBe('2080.00');
  });

  it('is resolved ahead of the seeded global rule, because it is more specific', async () => {
    const id = await newRule({ level: 'CLIENT', clientId, percentage: '7' });

    const rows = await prisma.feeRule.findMany({ where: { isActive: true } });
    const resolved = resolveRule(
      rows.map((row) => ({
        id: row.id,
        level: row.level,
        engagementType: row.engagementType,
        feeKind: row.feeKind,
        clientId: row.clientId,
        clientGroup: row.clientGroup,
        partnerUserId: row.partnerUserId,
        isActive: row.isActive,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
        method: row.method,
        percentage: row.percentage?.toString() ?? null,
        fixedAmount: row.fixedAmount?.toString() ?? null,
        exactTarget: row.exactTarget?.toString() ?? null,
        skipRounding: row.skipRounding,
        appliesToAncillaryCharges: row.appliesToAncillaryCharges,
      })),
      { engagementType: 'T2', feeKind: 'T2_PREPARATION', clientId },
    );

    expect(resolved?.id).toBe(id);
  });

  it('records the creation with the whole rule', async () => {
    const id = await newRule({ percentage: '5' });

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { objectType: 'FeeRule', objectId: id },
    });

    expect(event.userId).toBe(actorId);
    expect(event.beforeValue).toBeNull();
    expect(event.afterValue).toMatchObject({ method: 'PERCENTAGE', created: true });
  });
});

describe('what it refuses', () => {
  it('refuses a rule scoped to nothing, which would never match', async () => {
    await expect(save({ level: 'ENGAGEMENT_TYPE', engagementType: null })).rejects.toThrow(
      /needs an engagement type/i,
    );
    await expect(save({ level: 'CLIENT', clientId: null })).rejects.toThrow(/needs a client/i);
    await expect(
      save({ level: 'PARTNER_OR_GROUP', partnerUserId: null, clientGroup: null }),
    ).rejects.toThrow(/needs a partner or a client group/i);
  });

  it('refuses a method with no value, which would produce no fee', async () => {
    await expect(save({ method: 'PERCENTAGE', percentage: null })).rejects.toThrow(/needs a percentage/i);
    await expect(save({ method: 'FIXED_AMOUNT', fixedAmount: null })).rejects.toThrow(/needs a fixedAmount/i);
    await expect(save({ method: 'EXACT_TARGET', exactTarget: null })).rejects.toThrow(/needs a exactTarget/i);
  });

  it('accepts no-increase without a value, because it needs none', async () => {
    const id = await newRule({ method: 'NO_INCREASE', percentage: null });

    const rule = await feeRules.get(id);
    expect(rule.method).toBe('NO_INCREASE');
    expect(rule.percentage).toBeNull();
  });

  it('refuses a negative or unreadable amount', async () => {
    await expect(save({ percentage: '-3' })).rejects.toThrow(/cannot be negative/i);
    await expect(save({ percentage: 'three percent' })).rejects.toThrow(/must be a number/i);
  });

  it('refuses a change with no real reason', async () => {
    await expect(save({ reason: '' })).rejects.toThrow(/Give a reason/i);
    await expect(save({ reason: '   short  ' })).rejects.toThrow(/Give a reason/i);
  });

  it('refuses a rule that stops applying before it starts', async () => {
    await expect(save({ effectiveFrom: '2026-06-30', effectiveTo: '2026-01-01' })).rejects.toThrow(
      /cannot stop applying before it starts/i,
    );
  });

  it('refuses a date that is not real', async () => {
    await expect(save({ effectiveFrom: '2026-02-31' })).rejects.toThrow(/not a real date/i);
  });
});

describe('narrowing a rule', () => {
  it('clears the scope a level no longer uses, so a leftover cannot keep matching', async () => {
    const id = await newRule({ level: 'CLIENT', clientId, engagementType: 'T2' });

    await feeRules.save({
      id,
      actorId,
      reason: 'Broadened back to a global default for everyone.',
      level: 'GLOBAL',
      method: 'PERCENTAGE',
      percentage: '3',
      skipRounding: false,
      appliesToAncillaryCharges: false,
      isActive: true,
    });

    const rule = await feeRules.get(id);
    expect(rule.level).toBe('GLOBAL');
    expect(rule.clientId).toBeNull();
    expect(rule.engagementType).toBeNull();
  });

  it('clears the value belonging to a method it no longer uses', async () => {
    const id = await newRule({ method: 'PERCENTAGE', percentage: '4' });

    await feeRules.save({
      id,
      actorId,
      reason: 'Switched this client to a flat target price.',
      level: 'ENGAGEMENT_TYPE',
      engagementType: 'T2',
      method: 'EXACT_TARGET',
      exactTarget: '2500',
      skipRounding: false,
      appliesToAncillaryCharges: false,
      isActive: true,
    });

    const rule = await feeRules.get(id);
    expect(rule.percentage).toBeNull();
    expect(Number(rule.exactTarget)).toBe(2500);
  });
});

describe('what a change does to fees already calculated', () => {
  it('counts the unapproved separately from the approved', async () => {
    const id = await newRule();

    const engagement = await prisma.engagement.create({
      data: {
        clientId,
        engagementType: 'T2',
        taxYear: TAX_YEAR,
        yearEnd: new Date(Date.UTC(TAX_YEAR, 2, 31)),
        status: 'NOT_STARTED',
        isTestMode: true,
      },
    });

    await prisma.feeCalculation.createMany({
      data: [
        {
          engagementId: engagement.id,
          feeRuleId: id,
          feeKind: 'T2_PREPARATION',
          method: 'PERCENTAGE',
          roundedFee: '2080',
        },
        {
          engagementId: engagement.id,
          feeRuleId: id,
          feeKind: 'CSRS_4200_COMPILATION',
          method: 'PERCENTAGE',
          roundedFee: '1040',
          approvedByUserId: actorId,
          approvedAt: new Date(),
        },
      ],
    });

    expect(await feeRules.impactOf(id)).toEqual({ pendingRecalculation: 1, approved: 1 });
  });

  it('leaves an approved fee exactly as it was', async () => {
    const id = await newRule();

    const engagement = await prisma.engagement.create({
      data: {
        clientId,
        engagementType: 'T3',
        taxYear: TAX_YEAR,
        yearEnd: new Date(Date.UTC(TAX_YEAR, 11, 31)),
        status: 'NOT_STARTED',
        isTestMode: true,
      },
    });

    const approved = await prisma.feeCalculation.create({
      data: {
        engagementId: engagement.id,
        feeRuleId: id,
        feeKind: 'T3_PREPARATION',
        method: 'PERCENTAGE',
        roundedFee: '2080',
        approvedByUserId: actorId,
        approvedAt: new Date(),
      },
    });

    const outcome = await feeRules.save({
      id,
      actorId,
      reason: 'Increase revised upward after the partner meeting.',
      level: 'ENGAGEMENT_TYPE',
      engagementType: 'T2',
      method: 'PERCENTAGE',
      percentage: '9',
      skipRounding: false,
      appliesToAncillaryCharges: false,
      isActive: true,
    });

    expect(outcome.impact.approved).toBe(1);

    // The rule changed; the approved number did not.
    const after = await prisma.feeCalculation.findUniqueOrThrow({ where: { id: approved.id } });
    expect(after.roundedFee?.toString()).toBe('2080');
    expect(after.approvedAt).not.toBeNull();
  });
});
