import { resolve } from 'node:path';
import { prisma } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { libreOfficeConverter } from '@element/documents';
import {
  ApprovalService,
  BulkRolloutService,
  ClientImportService,
  CoverLetterService,
  CoverLetterNarrativeService,
  IntegrationConnectionService,
  TemplatePublishService,
  TemplatePreviewService,
  UserAdminService,
  DateRuleService,
  DocumentStore,
  EngagementService,
  ExternalSignatureService,
  FeeRuleService,
  FieldFormService,
  GenerationService,
  JobQueue,
  KarbonNotificationService,
  NotificationService,
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
const feeRules = new FeeRuleService({ prisma, audit });
const engagements = new EngagementService({ prisma, audit });

const store = new DocumentStore({
  prisma,
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
const userNotifications = new NotificationService({ prisma });
const clientImport = new ClientImportService({ prisma, audit, logger });
const signing = new SigningService({ notifications: userNotifications, prisma, audit, store, workflow, settings, logger });
const externalSignature = new ExternalSignatureService({
  notifications: userNotifications,
  prisma,
  audit,
  store,
  workflow,
  logger,
});
const coverLetters = new CoverLetterService({
  prisma,
  audit,
  store,
  pdfConverter,
  workflow,
  logger,
  templateDirectory,
});

const coverLetterNarratives = new CoverLetterNarrativeService({
  prisma,
  audit,
  templateDirectory,
});

const users = new UserAdminService({ prisma, audit });

const integrations = new IntegrationConnectionService({
  prisma,
  audit,
  logger,
  encryptionKey: env().ENCRYPTION_KEY,
});

const templatePublishing = new TemplatePublishService({ prisma, audit, store });
const templatePreviews = new TemplatePreviewService({
  prisma,
  store,
  pdfConverter,
  templateDirectory,
  // Disposable: it holds nothing that cannot be rebuilt from the template,
  // so it lives with the other scratch space rather than in the document
  // store, whose contents are subject to the retention purge.
  cacheDirectory: resolve(configuration.DOCUMENT_TEMP_DIRECTORY, 'template-previews'),
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
  feeRules,
  sourceDocuments,
  store,
  generation,
  approvals,
  signing,
  clientImport,
  externalSignature,
  coverLetters,
  coverLetterNarratives,
  users,
  integrations,
  templatePublishing,
  templatePreviews,
  userNotifications,
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
