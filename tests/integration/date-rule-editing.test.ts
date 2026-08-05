import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { evaluateDateRule } from '@element/dates';
import { DateRuleService } from '@element/services';

/**
 * Editing a date rule.
 *
 * A date rule is the firm's interpretation of a statutory deadline, so the
 * properties that matter are about restraint and traceability: a rule that
 * would produce nothing is refused, a change carries a written reason and the
 * whole definition before and after, and a date a reviewer already confirmed is
 * never rewritten by a later edit.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);
const dateRules = new DateRuleService({ prisma, audit });

let actorId: string;
let clientId: string;
const ruleCodes: string[] = [];

const TAX_YEAR = 2026;

beforeAll(async () => {
  await prisma.$connect();

  const actor = await prisma.user.upsert({
    where: { email: 'date-rule-test@example.test' },
    create: { email: 'date-rule-test@example.test', displayName: 'Date Rule Test' },
    update: {},
  });
  actorId = actor.id;

  const client = await prisma.client.create({
    data: { legalName: `Date Rule Co ${randomUUID().slice(0, 8)}`, isTestFixture: true },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.engagement.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.dateRule.deleteMany({ where: { code: { in: ruleCodes } } });
  await prisma.$disconnect();
});

/** A rule of its own per test, so edits cannot disturb the seeded ones. */
async function newRule(overrides: Record<string, unknown> = {}): Promise<string> {
  const code = `test.rule_${randomUUID().slice(0, 8)}`;
  ruleCodes.push(code);

  await prisma.dateRule.create({
    data: {
      code,
      label: 'Test deadline',
      engagementType: 'T2',
      requiresConfirmation: true,
      definition: {
        base: 'YEAR_END',
        steps: [{ op: 'ADD_MONTHS', months: 6 }],
        branches: [],
        requiredFacts: [],
        assumption: 'Six months after the year-end.',
        rollToBusinessDay: false,
        requiresConfirmation: true,
      },
      ...overrides,
    } as never,
  });

  return code;
}

function update(code: string, overrides: Record<string, unknown> = {}) {
  return dateRules.update({
    code,
    actorId,
    reason: 'The firm reviewed its interpretation for the new year.',
    label: 'Test deadline',
    notes: null,
    isActive: true,
    requiresConfirmation: true,
    definition: {
      base: 'YEAR_END',
      steps: [{ op: 'ADD_MONTHS', months: 3 }],
      branches: [],
      requiredFacts: [],
      assumption: 'Three months after the year-end.',
      rollToBusinessDay: false,
      requiresConfirmation: true,
    },
    ...overrides,
  });
}

describe('reading a rule', () => {
  it('parses the stored definition and reports one that does not', async () => {
    const good = await dateRules.get(await newRule());
    expect(good.definition?.base).toBe('YEAR_END');
    expect(good.definitionError).toBeNull();

    const broken = await dateRules.get(await newRule({ definition: { base: 'NOT_A_BASE' } }));
    expect(broken.definition).toBeNull();
    expect(broken.definitionError).toBeTruthy();
  });

  it('lists the seeded rules alongside any added', async () => {
    const list = await dateRules.list();

    expect(list.some((rule) => rule.code === 't2.filing_deadline')).toBe(true);
    expect(list.every((rule) => rule.code === rule.code.trim())).toBe(true);
  });
});

describe('changing a rule', () => {
  it('saves the new definition and records the whole change', async () => {
    const code = await newRule();

    await update(code, { reason: 'Aligning with the firm’s revised service standard.' });

    const rule = await dateRules.get(code);
    expect(rule.definition?.steps).toEqual([{ op: 'ADD_MONTHS', months: 3 }]);
    expect(rule.definition?.assumption).toBe('Three months after the year-end.');

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { objectType: 'DateRule', objectId: code },
    });

    expect(event.userId).toBe(actorId);
    expect(event.reason).toContain('revised service standard');
    // Both sides, so the previous interpretation can be reconstructed.
    expect(JSON.stringify(event.beforeValue)).toContain('"months":6');
    expect(JSON.stringify(event.afterValue)).toContain('"months":3');
  });

  it('produces the new deadline when the engine next runs', async () => {
    const code = await newRule();
    await update(code);

    const rule = await dateRules.get(code);
    const outcome = evaluateDateRule(code, rule.definition, {
      yearEnd: new Date(Date.UTC(TAX_YEAR, 2, 31)),
      taxYear: TAX_YEAR,
    });

    expect(outcome.resultIso).toBe(`${TAX_YEAR}-06-30`);
    expect(outcome.assumptions).toContain('Three months after the year-end.');
  });

  it('can deactivate a rule', async () => {
    const code = await newRule();
    await update(code, { isActive: false });

    expect((await dateRules.get(code)).isActive).toBe(false);
  });
});

describe('what it refuses', () => {
  it('refuses a change with no real reason', async () => {
    const code = await newRule();

    await expect(update(code, { reason: '' })).rejects.toThrow(/Give a reason/i);
    await expect(update(code, { reason: 'because' })).rejects.toThrow(/Give a reason/i);
  });

  it('refuses a definition that does not parse, and lists what is wrong', async () => {
    const code = await newRule();

    await expect(update(code, { definition: { base: 'NOT_A_BASE', steps: [] } })).rejects.toThrow(/not valid/i);

    // The stored rule is untouched.
    expect((await dateRules.get(code)).definition?.steps).toEqual([{ op: 'ADD_MONTHS', months: 6 }]);
  });

  it('refuses a rule with no steps at all', async () => {
    const code = await newRule();

    await expect(
      update(code, {
        definition: {
          base: 'YEAR_END',
          steps: [],
          branches: [],
          requiredFacts: [],
          rollToBusinessDay: false,
          requiresConfirmation: true,
        },
      }),
    ).rejects.toThrow(/at least one step/i);
  });

  it('refuses an empty label', async () => {
    const code = await newRule();
    await expect(update(code, { label: '   ' })).rejects.toThrow(/needs a label/i);
  });

  it('refuses a rule that does not exist', async () => {
    await expect(update('test.no_such_rule')).rejects.toThrow(/not found/i);
  });
});

describe('what a change does to dates already calculated', () => {
  it('counts the unconfirmed separately from the confirmed', async () => {
    const code = await newRule();

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

    await prisma.calculatedDate.createMany({
      data: [
        {
          engagementId: engagement.id,
          token: 'dates.filing_due',
          ruleCode: code,
          result: new Date(Date.UTC(TAX_YEAR, 8, 30)),
        },
        {
          engagementId: engagement.id,
          token: 'dates.balance_due',
          ruleCode: code,
          result: new Date(Date.UTC(TAX_YEAR, 4, 31)),
          confirmedByUserId: actorId,
          confirmedAt: new Date(),
        },
      ],
    });

    const impact = await dateRules.impactOf(code);
    expect(impact).toEqual({ pendingRecalculation: 1, confirmed: 1 });
  });

  it('leaves a confirmed date exactly as it was', async () => {
    const code = await newRule();

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

    const confirmedResult = new Date(Date.UTC(TAX_YEAR, 8, 30));
    const confirmed = await prisma.calculatedDate.create({
      data: {
        engagementId: engagement.id,
        token: 'dates.filing_due',
        ruleCode: code,
        result: confirmedResult,
        confirmedByUserId: actorId,
        confirmedAt: new Date(),
      },
    });

    const outcome = await update(code);
    expect(outcome.impact.confirmed).toBe(1);

    // The rule changed; the decision did not.
    const after = await prisma.calculatedDate.findUniqueOrThrow({ where: { id: confirmed.id } });
    expect(after.result?.toISOString()).toBe(confirmedResult.toISOString());
    expect(after.confirmedAt).not.toBeNull();
  });
});
