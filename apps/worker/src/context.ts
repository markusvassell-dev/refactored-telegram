import { prisma } from '@element/database';
import { createAuditLogger, type AuditLogger } from '@element/audit';
import { libreOfficeConverter, type PdfConverter } from '@element/documents';
import {
  ApprovalService,
  CoverLetterService,
  DateRuleService,
  DocumentStore,
  EngagementService,
  FeeRuleService,
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
  type ResolvedProviders,
} from '@element/services';
import { createLogger, env, type Env, type Logger } from '@element/shared';
import { resolve } from 'node:path';

/**
 * Worker composition root.
 *
 * Everything the job handlers need is built once here, so a handler is a plain
 * function over an explicit context and can be tested with fakes.
 */

export interface WorkerContext {
  env: Env;
  logger: Logger;
  prisma: typeof prisma;
  audit: AuditLogger;
  store: DocumentStore;
  pdfConverter: PdfConverter;
  queue: JobQueue;
  settings: SettingsService;
  workflow: WorkflowService;
  pricing: PricingService;
  preparation: PreparationService;
  fields: FieldFormService;
  dateRules: DateRuleService;
  feeRules: FeeRuleService;
  engagements: EngagementService;
  sourceDocuments: SourceDocumentService;
  generation: GenerationService;
  approvals: ApprovalService;
  signing: SigningService;
  coverLetters: CoverLetterService;
  notifications: KarbonNotificationService;
  providers(): Promise<ResolvedProviders>;
  testMode(): Promise<{ testMode: boolean; productionSendingEnabled: boolean }>;
}

export function buildWorkerContext(): WorkerContext {
  const configuration = env();
  const logger = createLogger({ level: configuration.LOG_LEVEL, base: { service: 'worker' } });

  const audit = createAuditLogger(prisma);
  const settings = new SettingsService(prisma);

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

  const queue = new JobQueue(prisma, logger);
  const workflow = new WorkflowService(prisma, audit);
  const pricing = new PricingService(prisma, audit);
  const preparation = new PreparationService({ prisma, audit, pricing, logger });
  const fields = new FieldFormService({ prisma, audit });
  const dateRules = new DateRuleService({ prisma, audit });
  const feeRules = new FeeRuleService({ prisma, audit });
  const engagements = new EngagementService({ prisma, audit });

  const templateDirectory = resolve(process.cwd(), 'templates', 'normalized');

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

  async function testMode(): Promise<{ testMode: boolean; productionSendingEnabled: boolean }> {
    const state = await settings.testModeState(configuration);
    return { testMode: state.testMode, productionSendingEnabled: state.productionSendingEnabled };
  }

  return {
    env: configuration,
    logger,
    prisma,
    audit,
    store,
    pdfConverter,
    queue,
    settings,
    workflow,
    pricing,
    preparation,
    fields,
    engagements,
    dateRules,
    feeRules,
    sourceDocuments,
    generation,
    approvals,
    signing,
    coverLetters,
    notifications,
    testMode,
    providers: async () => {
      const state = await settings.testModeState(configuration);
      return resolveProviders({ prisma, env: configuration, testModeState: state, logger });
    },
  };
}
