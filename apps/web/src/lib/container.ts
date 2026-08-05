import { resolve } from 'node:path';
import { prisma } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { libreOfficeConverter } from '@element/documents';
import {
  ApprovalService,
  BulkRolloutService,
  CoverLetterService,
  DateRuleService,
  DocumentStore,
  EngagementService,
  FieldFormService,
  GenerationService,
  JobQueue,
  KarbonNotificationService,
  PreparationService,
  PricingService,
  SettingsService,
  SigningService,
  SourceDocumentService,
  WorkflowService,
  resolveProviders,
} from '@element/services';
import { createLogger, env } from '@element/shared';

/**
 * Web composition root.
 *
 * Business logic lives in the service layer; route handlers and server actions
 * only translate between HTTP and those services.
 */

const configuration = env();
const logger = createLogger({ level: configuration.LOG_LEVEL, base: { service: 'web' } });
const audit = createAuditLogger(prisma);
const settings = new SettingsService(prisma);
const queue = new JobQueue(prisma, logger);
const workflow = new WorkflowService(prisma, audit);
const pricing = new PricingService(prisma, audit);
const preparation = new PreparationService({ prisma, audit, pricing, logger });
const fields = new FieldFormService({ prisma, audit });
const dateRules = new DateRuleService({ prisma, audit });
const engagements = new EngagementService({ prisma, audit });

const store = new DocumentStore({
  rootDirectory: configuration.DOCUMENT_STORAGE_DIRECTORY,
  retentionHours: configuration.DOCUMENT_RETENTION_HOURS,
  maxBytes: configuration.DOCUMENT_MAX_UPLOAD_BYTES,
  signingSecret: configuration.SESSION_SECRET,
});

const pdfConverter = libreOfficeConverter({
  binary: configuration.LIBREOFFICE_BINARY,
  timeoutMs: configuration.PDF_CONVERSION_TIMEOUT_MS,
  tempDirectory: configuration.DOCUMENT_TEMP_DIRECTORY,
});

const templateDirectory = resolve(process.cwd(), '..', '..', 'templates', 'normalized');

const generation = new GenerationService({
  prisma,
  audit,
  store,
  pdfConverter,
  workflow,
  logger,
  templateDirectory,
});

const sourceDocuments = new SourceDocumentService({ prisma, audit, store });
const approvals = new ApprovalService({ prisma, audit, workflow, settings });
const signing = new SigningService({ prisma, audit, store, workflow, settings, logger });
const coverLetters = new CoverLetterService({
  prisma,
  audit,
  store,
  pdfConverter,
  workflow,
  logger,
  templateDirectory,
});
const notifications = new KarbonNotificationService({
  prisma,
  audit,
  store,
  logger,
  appBaseUrl: configuration.APP_BASE_URL,
});
const bulk = new BulkRolloutService(prisma, queue, audit);

export const container = {
  env: configuration,
  logger,
  prisma,
  audit,
  settings,
  queue,
  workflow,
  pricing,
  preparation,
  fields,
  engagements,
  dateRules,
  sourceDocuments,
  store,
  generation,
  approvals,
  signing,
  coverLetters,
  notifications,
  bulk,
  async testModeState() {
    return settings.testModeState(configuration);
  },
  async providers() {
    const state = await settings.testModeState(configuration);
    return resolveProviders({ prisma, env: configuration, testModeState: state, logger });
  },
};

export type Container = typeof container;
