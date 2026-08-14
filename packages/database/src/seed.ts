/**
 * Database seed.
 *
 *   pnpm db:seed
 *
 * Registers the approved templates, the default pricing and date rules, the
 * workflow policy defaults, and a small set of clearly-marked sample clients
 * for Test Mode. It contains no real client information and no credentials.
 *
 * The seed is idempotent: running it twice changes nothing.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sha256Hex, type DocumentType, type Role } from '@element/shared';
import { DEFAULT_DATE_RULES } from '@element/dates';
import { parseManifest } from '@element/documents';
import { AWAITING_APPROVED_TEMPLATE, PRODUCTION_SUPPORTED_DOCUMENT_TYPES } from '@element/shared';
import { prisma } from './client.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const MANIFEST_DIR = join(ROOT, 'templates', 'manifests');
const NORMALIZED_DIR = join(ROOT, 'templates', 'normalized');

const TEMPLATE_NAMES: Record<DocumentType, string> = {
  T1_JOINT_ENGAGEMENT_LETTER: 'T1 Joint Taxpayer Engagement Letter',
  T1_SINGLE_ENGAGEMENT_LETTER: 'T1 Single Taxpayer Engagement Letter',
  T2_ENGAGEMENT_LETTER: 'T2 Corporate Engagement Letter',
  T3_ENGAGEMENT_LETTER: 'T3 Trust Engagement Letter',
  T1_COVER_LETTER: 'T1 Personal Income Tax Cover Letter',
  T2_COVER_LETTER: 'T2 Completion Cover Letter (non-compilation)',
  T3_COVER_LETTER: 'T3 Completion Cover Letter',
  COMPILATION_COVER_LETTER: 'Compilation Engagement Cover Letter',
};

async function seedTemplates(): Promise<void> {
  let manifestFiles: string[] = [];
  try {
    manifestFiles = (await readdir(MANIFEST_DIR)).filter((name) => name.endsWith('.json'));
  } catch {
    process.stdout.write('No template manifests found. Run `pnpm templates:normalize` first.\n');
  }

  for (const fileName of manifestFiles) {
    // Parsed against the real schema rather than a hand-written structural
    // type: a manifest property added later must not be silently dropped here.
    const manifest = parseManifest(JSON.parse(await readFile(join(MANIFEST_DIR, fileName), 'utf8')));

    const normalizedPath = join(NORMALIZED_DIR, manifest.sourceFileName);
    const normalizedHash = await readFile(normalizedPath)
      .then((data) => sha256Hex(data))
      .catch(() => manifest.normalizedFileHash ?? null);

    const template = await prisma.documentTemplate.upsert({
      where: { documentType: manifest.documentType },
      create: {
        documentType: manifest.documentType,
        name: TEMPLATE_NAMES[manifest.documentType],
        description: `Approved master template: ${manifest.sourceFileName}`,
        isProductionSupported: PRODUCTION_SUPPORTED_DOCUMENT_TYPES.includes(manifest.documentType),
      },
      update: {
        isProductionSupported: PRODUCTION_SUPPORTED_DOCUMENT_TYPES.includes(manifest.documentType),
      },
    });

    const existing = await prisma.templateVersion.findUnique({
      where: { templateId_versionNumber: { templateId: template.id, versionNumber: 1 } },
    });

    if (existing) {
      // A published version is immutable; the database enforces that too.
      continue;
    }

    const version = await prisma.templateVersion.create({
      data: {
        templateId: template.id,
        versionNumber: 1,
        status: 'ACTIVE',
        sourceFileHash: manifest.sourceFileHash,
        sourceFileName: manifest.sourceFileName,
        normalizedFileHash: normalizedHash,
        normalizedPath,
        manifest: manifest as never,
        notes: 'Seeded from the approved source template supplied for the initial release.',
        approvedAt: new Date(),
        activatedAt: new Date(),
      },
    });

    // The field definitions are the projection of the manifest the review UI
    // reads. Everything the UI needs to render a correct input is written here
    // so it never has to re-parse the manifest JSON.
    await prisma.templateFieldDefinition.createMany({
      data: manifest.fields.map((field) => ({
        templateVersionId: version.id,
        token: field.token,
        label: field.label,
        dataType: field.dataType,
        isRequired: field.required,
        isAutoPopulatable: field.autoPopulatable,
        isLockedWording: false,
        helpText: field.helpText ?? null,
        displayGroup: field.displayGroup,
        displayOrder: field.displayOrder,
        sourcePlaceholder: field.sourcePlaceholder ?? null,
        enumValues: field.enumValues ?? [],
        maxLength: field.maxLength ?? null,
        requiredWhenSection: field.requiredWhenSection ?? null,
      })),
      skipDuplicates: true,
    });

    process.stdout.write(`  template  ${manifest.documentType} v1 activated\n`);
  }

  // Document types with no approved template stay unavailable for production
  // generation. We never invent legal wording for them.
  for (const documentType of AWAITING_APPROVED_TEMPLATE) {
    await prisma.documentTemplate.upsert({
      where: { documentType },
      create: {
        documentType,
        name: TEMPLATE_NAMES[documentType],
        description:
          'No approved master template has been supplied. An administrator must upload and activate one before this document can be generated.',
        isProductionSupported: false,
      },
      update: { isProductionSupported: false },
    });
    process.stdout.write(`  template  ${documentType} registered as awaiting an approved template\n`);
  }
}

async function seedDateRules(): Promise<void> {
  for (const rule of DEFAULT_DATE_RULES) {
    await prisma.dateRule.upsert({
      where: { code: rule.code },
      create: {
        code: rule.code,
        label: rule.label,
        engagementType: rule.engagementType,
        definition: rule.definition as never,
        requiresConfirmation: rule.definition.requiresConfirmation ?? true,
        notes: rule.notes,
      },
      update: {},
    });
  }
  process.stdout.write(`  dates     ${DEFAULT_DATE_RULES.length} date rules seeded\n`);
}

async function seedFeeRules(): Promise<void> {
  const existing = await prisma.feeRule.count();
  if (existing > 0) return;

  await prisma.feeRule.createMany({
    data: [
      {
        level: 'GLOBAL',
        method: 'PERCENTAGE',
        percentage: '3.0000',
        description: 'Global default: 3% annual increase, rounded up to the next $5.',
      },
      {
        level: 'ENGAGEMENT_TYPE',
        engagementType: 'T2',
        feeKind: 'T2_PREPARATION',
        method: 'PERCENTAGE',
        percentage: '3.0000',
        description: 'T2 preparation default increase.',
      },
      {
        level: 'ENGAGEMENT_TYPE',
        engagementType: 'T2',
        feeKind: 'CSRS_4200_COMPILATION',
        method: 'PERCENTAGE',
        percentage: '3.5000',
        description: 'CSRS 4200 compilation default increase, priced separately from the T2 fee.',
      },
      {
        level: 'ENGAGEMENT_TYPE',
        engagementType: 'T1_JOINT',
        feeKind: 'T1_PREPARATION',
        method: 'PERCENTAGE',
        percentage: '3.0000',
        description: 'T1 joint preparation default increase.',
      },
      {
        level: 'ENGAGEMENT_TYPE',
        engagementType: 'T3',
        feeKind: 'T3_PREPARATION',
        method: 'PERCENTAGE',
        percentage: '3.0000',
        description: 'T3 trust preparation default increase.',
      },
    ],
  });

  process.stdout.write('  pricing   default price rules seeded\n');
}

async function seedSettings(): Promise<void> {
  const settings: { key: string; value: unknown; description: string }[] = [
    { key: 'test_mode', value: true, description: 'Test Mode. Defaults to on so a new deployment fails safe.' },
    {
      key: 'production_sending_enabled',
      value: false,
      description: 'Production sending must be armed explicitly by an administrator.',
    },
    {
      key: 'high_fee_increase_threshold_percent',
      value: 10,
      description: 'Increases above this percentage require partner approval.',
    },
    {
      key: 'require_final_approver_by_engagement_type',
      value: { T1_JOINT: true, T1_SINGLE: true, T2: true, T3: true },
      description: 'Whether a partner or final approver must approve before sending.',
    },
    {
      key: 'prior_year_filename_patterns',
      value: ['{year} {typeLabel}', '{typeLabel} {year}', '{year} engagement letter', '{clientName} {year}'],
      description: 'Filename hints used when searching Karbon. Never sufficient on their own.',
    },
    {
      key: 'karbon_status_triggers',
      value: [],
      description:
        'Karbon Work Item statuses that may trigger generation. Free-text comments are never used as a trigger.',
    },
    { key: 'karbon_status_map', value: {}, description: 'Application status to Karbon work status mapping.' },
    { key: 'product_name', value: 'Element Engagements', description: 'Displayed product name.' },
    { key: 'ai_extraction_enabled', value: false, description: 'AI-assisted extraction is opt-in.' },
    { key: 'document_retention_hours', value: 72, description: 'Retention period for temporary working copies.' },
  ];

  for (const setting of settings) {
    await prisma.systemSetting.upsert({
      where: { key: setting.key },
      create: { key: setting.key, value: setting.value as never, description: setting.description },
      update: { description: setting.description },
    });
  }

  process.stdout.write(`  settings  ${settings.length} system settings seeded\n`);
}

async function seedIntegrationPlaceholders(): Promise<void> {
  for (const provider of ['KARBON', 'ADOBE_SIGN', 'ENTRA_ID', 'AI_EXTRACTION'] as const) {
    await prisma.integrationConnection.upsert({
      where: { provider },
      create: {
        provider,
        displayName: provider.replace(/_/g, ' '),
        isEnabled: false,
        isSandbox: true,
        // No credentials are seeded. They are supplied at runtime and stored
        // encrypted; nothing secret is ever committed.
        encryptedCredentials: null,
      },
      update: {},
    });
  }
  process.stdout.write('  providers integration connections registered (disabled, no credentials)\n');
}

/** Development-only users. Sign-in still goes through Entra ID in production. */
async function seedDevelopmentUsers(): Promise<void> {
  if (process.env.APP_ENV === 'production' || process.env.APP_ENV === 'staging') return;

  const users: { email: string; displayName: string; roles: Role[] }[] = [
    { email: 'admin@example.test', displayName: 'Sample Administrator', roles: ['ADMINISTRATOR'] },
    { email: 'partner@example.test', displayName: 'Sample Partner', roles: ['PARTNER_OR_FINAL_APPROVER'] },
    { email: 'reviewer@example.test', displayName: 'Sample Reviewer', roles: ['REVIEWER'] },
    { email: 'preparer@example.test', displayName: 'Sample Preparer', roles: ['PREPARER'] },
    { email: 'viewer@example.test', displayName: 'Sample Viewer', roles: ['READ_ONLY'] },
  ];

  for (const user of users) {
    const record = await prisma.user.upsert({
      where: { email: user.email },
      create: { email: user.email, displayName: user.displayName },
      update: { displayName: user.displayName },
    });

    for (const role of user.roles) {
      await prisma.userRole.upsert({
        where: { userId_role: { userId: record.id, role } },
        create: { userId: record.id, role },
        update: {},
      });
    }
  }

  process.stdout.write(`  users     ${users.length} development users seeded\n`);
}

/** Obviously-fake sample clients used by Test Mode. No real client data. */
async function seedSampleClients(): Promise<void> {
  if (process.env.APP_ENV === 'production') return;

  const samples = [
    {
      karbonEntityKey: 'SAMPLE-ORG-1',
      legalName: 'Northwind Sample Holdings Ltd.',
      businessNumber: '00000 0000 RC0001',
      clientGroup: 'Sample Group A',
      contacts: [
        { fullLegalName: 'Sample Signing Officer', firstName: 'Sample', email: 'officer@example.test', title: 'President' },
      ],
    },
    {
      karbonEntityKey: 'SAMPLE-ORG-2',
      legalName: 'Lakeside Sample Consulting Inc.',
      businessNumber: '00000 0000 RC0002',
      clientGroup: 'Sample Group A',
      contacts: [
        { fullLegalName: 'Sample Director', firstName: 'Sample', email: 'director@example.test', title: 'Director' },
      ],
    },
    {
      karbonEntityKey: 'SAMPLE-TRUST-1',
      legalName: 'The Sample Family Trust',
      businessNumber: null,
      clientGroup: 'Sample Group B',
      contacts: [
        { fullLegalName: 'Sample Trustee', firstName: 'Sample', email: 'trustee@example.test', title: 'Trustee' },
      ],
    },
  ];

  for (const sample of samples) {
    const client = await prisma.client.upsert({
      where: { karbonEntityKey: sample.karbonEntityKey },
      create: {
        karbonEntityKey: sample.karbonEntityKey,
        karbonEntityType: 'Organization',
        legalName: sample.legalName,
        businessNumber: sample.businessNumber,
        clientGroup: sample.clientGroup,
        addressLine1: '100 Sample Street',
        city: 'Calgary',
        province: 'Alberta',
        postalCode: 'T2A 0A0',
        isTestFixture: true,
      },
      update: { isTestFixture: true },
    });

    for (const contact of sample.contacts) {
      const existing = await prisma.clientContact.findFirst({
        where: { clientId: client.id, fullLegalName: contact.fullLegalName },
      });
      if (!existing) {
        await prisma.clientContact.create({
          data: { clientId: client.id, ...contact, isPrimary: true },
        });
      }
    }
  }

  process.stdout.write(`  clients   ${samples.length} sample (test fixture) clients seeded\n`);
}

/**
 * One sample engagement so Test Mode has something to demonstrate.
 * It is deliberately left NOT_STARTED with the compilation selection
 * unconfirmed, which is exactly the state a reviewer has to resolve.
 */
async function seedSampleEngagement(): Promise<void> {
  if (process.env.APP_ENV === 'production') return;

  const client = await prisma.client.findUnique({ where: { karbonEntityKey: 'SAMPLE-ORG-1' } });
  if (!client) return;

  const taxYear = new Date().getUTCFullYear();

  const workItem = await prisma.karbonWorkItem.upsert({
    where: { karbonKey: 'SAMPLE-WI-T2' },
    create: {
      karbonKey: 'SAMPLE-WI-T2',
      clientId: client.id,
      title: `${taxYear} Corporate Tax`,
      workType: 'Corporate Tax',
      status: 'In Progress',
      taxYear,
    },
    update: {},
  });

  const existing = await prisma.engagement.findUnique({
    where: { clientId_engagementType_taxYear: { clientId: client.id, engagementType: 'T2', taxYear } },
  });
  if (existing) return;

  const reviewer = await prisma.user.findUnique({ where: { email: 'reviewer@example.test' } });
  const preparer = await prisma.user.findUnique({ where: { email: 'preparer@example.test' } });

  const engagement = await prisma.engagement.create({
    data: {
      clientId: client.id,
      engagementType: 'T2',
      taxYear,
      yearEnd: new Date(Date.UTC(taxYear, 2, 31)),
      karbonWorkItemId: workItem.id,
      status: 'NOT_STARTED',
      // Unconfirmed on purpose: a reviewer must decide before generation.
      compilationSelected: null,
      assignedPreparerId: preparer?.id ?? null,
      assignedReviewerId: reviewer?.id ?? null,
      isTestMode: true,
    },
  });

  await prisma.engagementParticipant.createMany({
    data: [
      {
        engagementId: engagement.id,
        role: 'AUTHORIZED_SIGNING_OFFICER',
        fullLegalName: 'Sample Signing Officer',
        email: 'officer@example.test',
        title: 'President',
        signingOrder: 1,
        isSigner: true,
      },
      {
        engagementId: engagement.id,
        role: 'ENGAGEMENT_LEAD',
        fullLegalName: 'Sample Lead',
        email: 'lead@example.test',
        signingOrder: 99,
        isSigner: false,
      },
    ],
    skipDuplicates: true,
  });

  process.stdout.write('  sample    one T2 engagement seeded for Test Mode\n');
}

async function main(): Promise<void> {
  process.stdout.write('Seeding Element Engagements\n');
  await seedTemplates();
  await seedDateRules();
  await seedFeeRules();
  await seedSettings();
  await seedIntegrationPlaceholders();
  await seedDevelopmentUsers();
  await seedSampleClients();
  await seedSampleEngagement();
  process.stdout.write('Seed complete.\n');
}

await main()
  .catch((error: unknown) => {
    process.stderr.write(`Seed failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
