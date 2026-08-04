-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMINISTRATOR', 'PARTNER_OR_FINAL_APPROVER', 'REVIEWER', 'PREPARER', 'READ_ONLY');

-- CreateEnum
CREATE TYPE "EngagementType" AS ENUM ('T1_JOINT', 'T1_SINGLE', 'T2', 'T3');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('T1_JOINT_ENGAGEMENT_LETTER', 'T1_SINGLE_ENGAGEMENT_LETTER', 'T2_ENGAGEMENT_LETTER', 'T3_ENGAGEMENT_LETTER', 'T1_COVER_LETTER', 'T2_COVER_LETTER', 'T3_COVER_LETTER', 'COMPILATION_COVER_LETTER');

-- CreateEnum
CREATE TYPE "EngagementStatus" AS ENUM ('NOT_STARTED', 'LOCATING_SOURCE_DOCUMENTS', 'SOURCE_DOCUMENT_REVIEW_REQUIRED', 'EXTRACTING_DATA', 'GENERATING', 'GENERATION_FAILED', 'DRAFT_READY', 'REVIEW_REQUIRED', 'IN_REVIEW', 'CHANGES_REQUESTED', 'REGENERATING', 'APPROVED', 'READY_TO_SEND', 'SENDING_FOR_SIGNATURE', 'SENT_FOR_SIGNATURE', 'PARTIALLY_SIGNED', 'SIGNED', 'DECLINED', 'EXPIRED', 'NEEDS_ATTENTION', 'COMPLETE', 'READY_FOR_COVER_LETTER', 'COVER_LETTER_GENERATING', 'COVER_LETTER_REVIEW_REQUIRED', 'COVER_LETTER_IN_REVIEW', 'COVER_LETTER_CHANGES_REQUESTED', 'COVER_LETTER_APPROVED', 'READY_FOR_DELIVERY');

-- CreateEnum
CREATE TYPE "DocumentVersionStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'SENT_FOR_SIGNATURE', 'SIGNED', 'SUPERSEDED', 'REJECTED', 'STALE');

-- CreateEnum
CREATE TYPE "FeeMethod" AS ENUM ('NO_INCREASE', 'PERCENTAGE', 'FIXED_AMOUNT', 'EXACT_TARGET');

-- CreateEnum
CREATE TYPE "FeeKind" AS ENUM ('T1_PREPARATION', 'T2_PREPARATION', 'T3_PREPARATION', 'CSRS_4200_COMPILATION');

-- CreateEnum
CREATE TYPE "FeeRuleLevel" AS ENUM ('GLOBAL', 'ENGAGEMENT_TYPE', 'PARTNER_OR_GROUP', 'CLIENT', 'ONE_TIME_OVERRIDE');

-- CreateEnum
CREATE TYPE "ValueSource" AS ENUM ('KARBON_CLIENT', 'KARBON_WORK_ITEM', 'PRIOR_YEAR_DOCUMENT', 'TEMPLATE_DEFAULT', 'MANUAL_ENTRY', 'CALCULATED');

-- CreateEnum
CREATE TYPE "ExtractionMethod" AS ENUM ('STRUCTURED_EXPORT', 'PDF_TEXT', 'DETERMINISTIC_PATTERN', 'AI_ASSISTED', 'OCR_VISION', 'MANUAL_ENTRY');

-- CreateEnum
CREATE TYPE "ApprovalType" AS ENUM ('ORDINARY_REVIEW', 'FINAL_DOCUMENT', 'WORDING_EXCEPTION', 'FEE_DECREASE', 'FEE_HIGH_INCREASE', 'COVER_LETTER', 'SEND_AUTHORIZATION', 'DATE_CONFIRMATION');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED', 'CHANGES_REQUESTED');

-- CreateEnum
CREATE TYPE "SourceDocumentKind" AS ENUM ('PRIOR_YEAR_ENGAGEMENT_LETTER', 'PRIOR_YEAR_SIGNED_LETTER', 'FINAL_T2_RETURN', 'COMPILED_FINANCIAL_STATEMENTS', 'COMPILATION_ENGAGEMENT_REPORT', 'FEDERAL_FILING_AUTHORIZATION', 'PROVINCIAL_FILING_AUTHORIZATION', 'ADJUSTING_JOURNAL_ENTRIES', 'TRIAL_BALANCE', 'INSTALMENT_SCHEDULE', 'PAYMENT_SUMMARY', 'T1_RETURN', 'T183', 'OTHER_SUPPORTING_SCHEDULE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "TemplateVersionStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AdobeAgreementStatus" AS ENUM ('CREATED', 'OUT_FOR_SIGNATURE', 'PARTIALLY_SIGNED', 'SIGNED', 'COMPLETED', 'DECLINED', 'CANCELLED', 'EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "AdobeSignerStatus" AS ENUM ('NOT_YET_NOTIFIED', 'WAITING_FOR_OTHERS', 'OUT_FOR_SIGNATURE', 'VIEWED', 'SIGNED', 'DECLINED', 'DELEGATED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RepresentativeCapacity" AS ENUM ('TRUSTEE', 'EXECUTOR', 'ADMINISTRATOR', 'LIQUIDATOR', 'OTHER_AUTHORIZED_REPRESENTATIVE');

-- CreateEnum
CREATE TYPE "ParticipantRole" AS ENUM ('TAXPAYER_1', 'TAXPAYER_2', 'AUTHORIZED_SIGNING_OFFICER', 'AUTHORIZED_REPRESENTATIVE', 'FIRM_SIGNER', 'ENGAGEMENT_PARTNER', 'ENGAGEMENT_LEAD', 'CC_RECIPIENT');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('KARBON', 'ADOBE_SIGN', 'ENTRA_ID', 'AI_EXTRACTION');

-- CreateEnum
CREATE TYPE "ConflictStatus" AS ENUM ('UNRESOLVED', 'RESOLVED', 'ACCEPTED_AS_IS');

-- CreateEnum
CREATE TYPE "CoverLetterStatus" AS ENUM ('BLOCKED', 'GENERATING', 'DRAFT', 'REVIEW_REQUIRED', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'READY_FOR_DELIVERY', 'STALE');

-- CreateEnum
CREATE TYPE "KarbonActivityType" AS ENUM ('DOCUMENT_UPLOAD', 'COMMENT', 'TASK_CREATE', 'TASK_UPDATE', 'TASK_COMPLETE', 'WORK_ITEM_STATUS_UPDATE', 'DOCUMENT_DOWNLOAD', 'SEARCH');

-- CreateEnum
CREATE TYPE "ActivityOutcome" AS ENUM ('SUCCEEDED', 'FAILED', 'SKIPPED_TEST_MODE', 'SKIPPED_UNSUPPORTED');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "entraObjectId" TEXT,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_role" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedBy" TEXT,

    CONSTRAINT "user_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client" (
    "id" TEXT NOT NULL,
    "karbonEntityKey" TEXT,
    "karbonEntityType" TEXT,
    "legalName" TEXT NOT NULL,
    "displayName" TEXT,
    "businessNumber" TEXT,
    "trustAccountNumber" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "province" TEXT,
    "postalCode" TEXT,
    "country" TEXT DEFAULT 'Canada',
    "clientGroup" TEXT,
    "partnerUserId" TEXT,
    "isTestFixture" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_contact" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "karbonContactKey" TEXT,
    "fullLegalName" TEXT NOT NULL,
    "firstName" TEXT,
    "email" TEXT,
    "telephone" TEXT,
    "title" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "karbon_work_item" (
    "id" TEXT NOT NULL,
    "karbonKey" TEXT NOT NULL,
    "clientId" TEXT,
    "title" TEXT NOT NULL,
    "workType" TEXT,
    "status" TEXT,
    "assigneeEmail" TEXT,
    "dueDate" TIMESTAMP(3),
    "taxYear" INTEGER,
    "yearEnd" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "rawSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "karbon_work_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "engagementType" "EngagementType" NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "yearEnd" TIMESTAMP(3),
    "karbonWorkItemId" TEXT,
    "status" "EngagementStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "templateVersionId" TEXT,
    "priorYearEngagementId" TEXT,
    "assignedPreparerId" TEXT,
    "assignedReviewerId" TEXT,
    "finalApproverId" TEXT,
    "compilationSelected" BOOLEAN,
    "blockedReason" TEXT,
    "isTestMode" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT,
    "initiatedBy" TEXT,
    "initiationSource" TEXT,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "engagement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_participant" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "clientContactId" TEXT,
    "role" "ParticipantRole" NOT NULL,
    "fullLegalName" TEXT NOT NULL,
    "firstName" TEXT,
    "email" TEXT,
    "telephone" TEXT,
    "title" TEXT,
    "representativeCapacity" "RepresentativeCapacity",
    "capacityConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "signingOrder" INTEGER NOT NULL DEFAULT 1,
    "isSigner" BOOLEAN NOT NULL DEFAULT false,
    "contactConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "engagement_participant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_template" (
    "id" TEXT NOT NULL,
    "documentType" "DocumentType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isProductionSupported" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_version" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "status" "TemplateVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "sourceFileHash" TEXT NOT NULL,
    "sourceFileName" TEXT NOT NULL,
    "normalizedFileHash" TEXT,
    "normalizedPath" TEXT,
    "manifest" JSONB NOT NULL,
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "template_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_field_definition" (
    "id" TEXT NOT NULL,
    "templateVersionId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "dataType" TEXT NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "isAutoPopulatable" BOOLEAN NOT NULL DEFAULT true,
    "isLockedWording" BOOLEAN NOT NULL DEFAULT false,
    "validationRule" JSONB,
    "defaultValue" TEXT,
    "helpText" TEXT,
    "displayGroup" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "template_field_definition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_document" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "kind" "SourceDocumentKind" NOT NULL DEFAULT 'UNKNOWN',
    "fileName" TEXT NOT NULL,
    "karbonDocumentId" TEXT,
    "karbonWorkItemKey" TEXT,
    "fileHash" TEXT NOT NULL,
    "byteSize" INTEGER,
    "mimeType" TEXT,
    "storagePath" TEXT,
    "pageCount" INTEGER,
    "verificationScore" DOUBLE PRECISION,
    "verificationDetail" JSONB,
    "confirmedByUserId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "includedInPackage" BOOLEAN NOT NULL DEFAULT false,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "supersededById" TEXT,
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purgeAfter" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_version" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "coverLetterPackageId" TEXT,
    "documentType" "DocumentType" NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "status" "DocumentVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "templateVersionId" TEXT,
    "sourceFileHash" TEXT,
    "generatedDocxReference" TEXT,
    "generatedPdfReference" TEXT,
    "docxHash" TEXT,
    "pdfHash" TEXT,
    "pageCount" INTEGER,
    "karbonDocumentId" TEXT,
    "karbonPdfDocumentId" TEXT,
    "renderedFieldValues" JSONB,
    "validationReport" JSONB,
    "changeSummary" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "document_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extracted_field" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "coverLetterPackageId" TEXT,
    "token" TEXT NOT NULL,
    "value" TEXT,
    "valueDecimal" DECIMAL(14,2),
    "valueDate" TIMESTAMP(3),
    "valueBoolean" BOOLEAN,
    "source" "ValueSource" NOT NULL,
    "extractionMethod" "ExtractionMethod" NOT NULL,
    "confidence" DOUBLE PRECISION,
    "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "manuallyConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "confirmedByUserId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "manualOverrideValue" TEXT,
    "overrideReason" TEXT,

    CONSTRAINT "extracted_field_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_evidence" (
    "id" TEXT NOT NULL,
    "extractedFieldId" TEXT NOT NULL,
    "sourceDocumentId" TEXT,
    "sourceDocumentHash" TEXT,
    "pageNumber" INTEGER,
    "supportingText" TEXT,
    "boundingBox" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "field_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_conflict" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "extractedFieldId" TEXT,
    "token" TEXT NOT NULL,
    "candidates" JSONB NOT NULL,
    "recommendedValue" TEXT,
    "recommendedSource" "ValueSource",
    "status" "ConflictStatus" NOT NULL DEFAULT 'UNRESOLVED',
    "resolvedValue" TEXT,
    "resolvedSource" "ValueSource",
    "resolvedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "field_conflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_selection" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "serviceCode" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isSelected" BOOLEAN NOT NULL DEFAULT false,
    "priorYearSelected" BOOLEAN,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "confirmedByUserId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "freeTextValue" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "service_selection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_rule" (
    "id" TEXT NOT NULL,
    "level" "FeeRuleLevel" NOT NULL,
    "engagementType" "EngagementType",
    "clientId" TEXT,
    "clientGroup" TEXT,
    "partnerUserId" TEXT,
    "feeKind" "FeeKind",
    "method" "FeeMethod" NOT NULL,
    "percentage" DECIMAL(7,4),
    "fixedAmount" DECIMAL(12,2),
    "exactTarget" DECIMAL(12,2),
    "skipRounding" BOOLEAN NOT NULL DEFAULT false,
    "appliesToAncillaryCharges" BOOLEAN NOT NULL DEFAULT false,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fee_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_calculation" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "feeKind" "FeeKind" NOT NULL,
    "feeRuleId" TEXT,
    "previousFee" DECIMAL(12,2),
    "previousFeeSource" "ValueSource",
    "previousFeeEvidence" TEXT,
    "method" "FeeMethod" NOT NULL,
    "percentage" DECIMAL(7,4),
    "fixedAmount" DECIMAL(12,2),
    "exactTarget" DECIMAL(12,2),
    "unroundedFee" DECIMAL(12,2),
    "roundedFee" DECIMAL(12,2),
    "increaseAmount" DECIMAL(12,2),
    "effectivePercentage" DECIMAL(9,4),
    "roundingApplied" BOOLEAN NOT NULL DEFAULT true,
    "isPreTax" BOOLEAN NOT NULL DEFAULT true,
    "taxNote" TEXT,
    "isManualOverride" BOOLEAN NOT NULL DEFAULT false,
    "overrideReason" TEXT,
    "requiresApprovalType" "ApprovalType",
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "warnings" JSONB,
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "blockedReason" TEXT,
    "calculatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fee_calculation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "date_rule" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "engagementType" "EngagementType",
    "definition" JSONB NOT NULL,
    "requiresConfirmation" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "date_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calculated_date" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "dateRuleId" TEXT,
    "token" TEXT NOT NULL,
    "inputDate" TIMESTAMP(3),
    "result" TIMESTAMP(3),
    "ruleCode" TEXT,
    "assumptions" JSONB,
    "source" "ValueSource" NOT NULL DEFAULT 'CALCULATED',
    "requiresConfirmation" BOOLEAN NOT NULL DEFAULT true,
    "confirmedByUserId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "blockedReason" TEXT,
    "manualOverride" TIMESTAMP(3),
    "overrideReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calculated_date_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_assignment" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedBy" TEXT,
    "dueDate" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "review_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_comment" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "documentVersionId" TEXT,
    "userId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "anchor" TEXT,
    "isInternal" BOOLEAN NOT NULL DEFAULT true,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "documentVersionId" TEXT,
    "coverLetterPackageId" TEXT,
    "type" "ApprovalType" NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "userId" TEXT NOT NULL,
    "actingRole" "Role" NOT NULL,
    "comment" TEXT,
    "exceptionsAccepted" JSONB,
    "documentHash" TEXT,
    "sourceDocumentVersions" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wording_exception" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "documentVersionId" TEXT,
    "sectionAnchor" TEXT NOT NULL,
    "originalWording" TEXT NOT NULL,
    "revisedWording" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "promotedToTemplateVersionId" TEXT,

    CONSTRAINT "wording_exception_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adobe_agreement" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "documentVersionId" TEXT NOT NULL,
    "agreementId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" "AdobeAgreementStatus" NOT NULL DEFAULT 'CREATED',
    "title" TEXT NOT NULL,
    "signingAttempt" INTEGER NOT NULL DEFAULT 1,
    "isTestMode" BOOLEAN NOT NULL DEFAULT false,
    "reminderFrequency" TEXT,
    "expiresAt" TIMESTAMP(3),
    "ccEmails" JSONB,
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "signedPdfKarbonDocumentId" TEXT,
    "certificateKarbonDocumentId" TEXT,
    "signedPdfHash" TEXT,
    "certificateHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "adobe_agreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adobe_signer" (
    "id" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "participantId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "ParticipantRole" NOT NULL,
    "signingOrder" INTEGER NOT NULL DEFAULT 1,
    "status" "AdobeSignerStatus" NOT NULL DEFAULT 'NOT_YET_NOTIFIED',
    "viewedAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "delegatedToEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "adobe_signer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adobe_event" (
    "id" TEXT NOT NULL,
    "agreementId" TEXT,
    "providerEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "signatureValid" BOOLEAN NOT NULL DEFAULT false,
    "processedAt" TIMESTAMP(3),
    "processingError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adobe_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cover_letter_package" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "documentType" "DocumentType" NOT NULL,
    "participantId" TEXT,
    "status" "CoverLetterStatus" NOT NULL DEFAULT 'BLOCKED',
    "idempotencyKey" TEXT NOT NULL,
    "sourceFingerprint" TEXT,
    "enclosures" JSONB,
    "blockedReason" TEXT,
    "staleReason" TEXT,
    "markedStaleAt" TIMESTAMP(3),
    "readyForDeliveryAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cover_letter_package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "karbon_activity" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT,
    "documentVersionId" TEXT,
    "karbonWorkItemKey" TEXT,
    "type" "KarbonActivityType" NOT NULL,
    "outcome" "ActivityOutcome" NOT NULL,
    "idempotencyKey" TEXT,
    "karbonObjectId" TEXT,
    "requestSummary" JSONB,
    "responseSummary" JSONB,
    "errorMessage" TEXT,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "karbon_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_connection" (
    "id" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "displayName" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "isSandbox" BOOLEAN NOT NULL DEFAULT true,
    "encryptedCredentials" TEXT,
    "baseUrl" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "lastCheckOk" BOOLEAN,
    "lastCheckError" TEXT,
    "capabilities" JSONB,
    "rotatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "background_job" (
    "id" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "engagementId" TEXT,
    "documentVersionId" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "failureDetail" JSONB,
    "userMessage" TEXT,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "background_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_event" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "fromStatus" "EngagementStatus",
    "toStatus" "EngagementStatus" NOT NULL,
    "reason" TEXT,
    "triggeredBy" TEXT,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "engagementId" TEXT,
    "eventType" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT,
    "beforeValue" JSONB,
    "afterValue" JSONB,
    "reason" TEXT,
    "correlationId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "isProtected" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "workflow_transition" (
    "fromStatus" "EngagementStatus" NOT NULL,
    "toStatus" "EngagementStatus" NOT NULL,

    CONSTRAINT "workflow_transition_pkey" PRIMARY KEY ("fromStatus","toStatus")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_entraObjectId_key" ON "user"("entraObjectId");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "user_isActive_idx" ON "user"("isActive");

-- CreateIndex
CREATE INDEX "user_role_role_idx" ON "user_role"("role");

-- CreateIndex
CREATE UNIQUE INDEX "user_role_userId_role_key" ON "user_role"("userId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "client_karbonEntityKey_key" ON "client"("karbonEntityKey");

-- CreateIndex
CREATE INDEX "client_legalName_idx" ON "client"("legalName");

-- CreateIndex
CREATE INDEX "client_clientGroup_idx" ON "client"("clientGroup");

-- CreateIndex
CREATE INDEX "client_isTestFixture_idx" ON "client"("isTestFixture");

-- CreateIndex
CREATE INDEX "client_contact_clientId_idx" ON "client_contact"("clientId");

-- CreateIndex
CREATE INDEX "client_contact_karbonContactKey_idx" ON "client_contact"("karbonContactKey");

-- CreateIndex
CREATE UNIQUE INDEX "karbon_work_item_karbonKey_key" ON "karbon_work_item"("karbonKey");

-- CreateIndex
CREATE INDEX "karbon_work_item_clientId_idx" ON "karbon_work_item"("clientId");

-- CreateIndex
CREATE INDEX "karbon_work_item_status_idx" ON "karbon_work_item"("status");

-- CreateIndex
CREATE INDEX "karbon_work_item_taxYear_idx" ON "karbon_work_item"("taxYear");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_idempotencyKey_key" ON "engagement"("idempotencyKey");

-- CreateIndex
CREATE INDEX "engagement_status_idx" ON "engagement"("status");

-- CreateIndex
CREATE INDEX "engagement_taxYear_engagementType_idx" ON "engagement"("taxYear", "engagementType");

-- CreateIndex
CREATE INDEX "engagement_assignedReviewerId_idx" ON "engagement"("assignedReviewerId");

-- CreateIndex
CREATE INDEX "engagement_isTestMode_idx" ON "engagement"("isTestMode");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_clientId_engagementType_taxYear_key" ON "engagement"("clientId", "engagementType", "taxYear");

-- CreateIndex
CREATE INDEX "engagement_participant_engagementId_idx" ON "engagement_participant"("engagementId");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_participant_engagementId_role_key" ON "engagement_participant"("engagementId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "document_template_documentType_key" ON "document_template"("documentType");

-- CreateIndex
CREATE INDEX "template_version_status_idx" ON "template_version"("status");

-- CreateIndex
CREATE UNIQUE INDEX "template_version_templateId_versionNumber_key" ON "template_version"("templateId", "versionNumber");

-- CreateIndex
CREATE INDEX "template_field_definition_templateVersionId_displayGroup_idx" ON "template_field_definition"("templateVersionId", "displayGroup");

-- CreateIndex
CREATE UNIQUE INDEX "template_field_definition_templateVersionId_token_key" ON "template_field_definition"("templateVersionId", "token");

-- CreateIndex
CREATE INDEX "source_document_engagementId_kind_idx" ON "source_document"("engagementId", "kind");

-- CreateIndex
CREATE INDEX "source_document_karbonDocumentId_idx" ON "source_document"("karbonDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "source_document_engagementId_fileHash_kind_key" ON "source_document"("engagementId", "fileHash", "kind");

-- CreateIndex
CREATE INDEX "document_version_engagementId_status_idx" ON "document_version"("engagementId", "status");

-- CreateIndex
CREATE INDEX "document_version_coverLetterPackageId_idx" ON "document_version"("coverLetterPackageId");

-- CreateIndex
CREATE UNIQUE INDEX "document_version_engagementId_documentType_versionNumber_key" ON "document_version"("engagementId", "documentType", "versionNumber");

-- CreateIndex
CREATE INDEX "extracted_field_engagementId_token_idx" ON "extracted_field"("engagementId", "token");

-- CreateIndex
CREATE INDEX "extracted_field_coverLetterPackageId_idx" ON "extracted_field"("coverLetterPackageId");

-- CreateIndex
CREATE UNIQUE INDEX "extracted_field_engagementId_coverLetterPackageId_token_sou_key" ON "extracted_field"("engagementId", "coverLetterPackageId", "token", "source");

-- CreateIndex
CREATE INDEX "field_evidence_extractedFieldId_idx" ON "field_evidence"("extractedFieldId");

-- CreateIndex
CREATE INDEX "field_conflict_engagementId_status_idx" ON "field_conflict"("engagementId", "status");

-- CreateIndex
CREATE INDEX "service_selection_engagementId_idx" ON "service_selection"("engagementId");

-- CreateIndex
CREATE UNIQUE INDEX "service_selection_engagementId_serviceCode_key" ON "service_selection"("engagementId", "serviceCode");

-- CreateIndex
CREATE INDEX "fee_rule_level_engagementType_idx" ON "fee_rule"("level", "engagementType");

-- CreateIndex
CREATE INDEX "fee_rule_clientId_idx" ON "fee_rule"("clientId");

-- CreateIndex
CREATE INDEX "fee_rule_isActive_idx" ON "fee_rule"("isActive");

-- CreateIndex
CREATE INDEX "fee_calculation_engagementId_idx" ON "fee_calculation"("engagementId");

-- CreateIndex
CREATE UNIQUE INDEX "fee_calculation_engagementId_feeKind_key" ON "fee_calculation"("engagementId", "feeKind");

-- CreateIndex
CREATE UNIQUE INDEX "date_rule_code_key" ON "date_rule"("code");

-- CreateIndex
CREATE INDEX "date_rule_engagementType_idx" ON "date_rule"("engagementType");

-- CreateIndex
CREATE INDEX "calculated_date_engagementId_idx" ON "calculated_date"("engagementId");

-- CreateIndex
CREATE UNIQUE INDEX "calculated_date_engagementId_token_key" ON "calculated_date"("engagementId", "token");

-- CreateIndex
CREATE INDEX "review_assignment_engagementId_idx" ON "review_assignment"("engagementId");

-- CreateIndex
CREATE INDEX "review_assignment_userId_completedAt_idx" ON "review_assignment"("userId", "completedAt");

-- CreateIndex
CREATE INDEX "review_comment_engagementId_idx" ON "review_comment"("engagementId");

-- CreateIndex
CREATE INDEX "review_comment_documentVersionId_idx" ON "review_comment"("documentVersionId");

-- CreateIndex
CREATE INDEX "approval_engagementId_type_idx" ON "approval"("engagementId", "type");

-- CreateIndex
CREATE INDEX "approval_documentVersionId_idx" ON "approval"("documentVersionId");

-- CreateIndex
CREATE INDEX "wording_exception_engagementId_idx" ON "wording_exception"("engagementId");

-- CreateIndex
CREATE UNIQUE INDEX "adobe_agreement_agreementId_key" ON "adobe_agreement"("agreementId");

-- CreateIndex
CREATE UNIQUE INDEX "adobe_agreement_idempotencyKey_key" ON "adobe_agreement"("idempotencyKey");

-- CreateIndex
CREATE INDEX "adobe_agreement_engagementId_idx" ON "adobe_agreement"("engagementId");

-- CreateIndex
CREATE INDEX "adobe_agreement_status_idx" ON "adobe_agreement"("status");

-- CreateIndex
CREATE INDEX "adobe_signer_agreementId_idx" ON "adobe_signer"("agreementId");

-- CreateIndex
CREATE UNIQUE INDEX "adobe_event_providerEventId_key" ON "adobe_event"("providerEventId");

-- CreateIndex
CREATE INDEX "adobe_event_agreementId_idx" ON "adobe_event"("agreementId");

-- CreateIndex
CREATE INDEX "adobe_event_eventType_idx" ON "adobe_event"("eventType");

-- CreateIndex
CREATE UNIQUE INDEX "cover_letter_package_idempotencyKey_key" ON "cover_letter_package"("idempotencyKey");

-- CreateIndex
CREATE INDEX "cover_letter_package_engagementId_status_idx" ON "cover_letter_package"("engagementId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "karbon_activity_idempotencyKey_key" ON "karbon_activity"("idempotencyKey");

-- CreateIndex
CREATE INDEX "karbon_activity_engagementId_idx" ON "karbon_activity"("engagementId");

-- CreateIndex
CREATE INDEX "karbon_activity_type_outcome_idx" ON "karbon_activity"("type", "outcome");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connection_provider_key" ON "integration_connection"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "background_job_idempotencyKey_key" ON "background_job"("idempotencyKey");

-- CreateIndex
CREATE INDEX "background_job_status_runAt_idx" ON "background_job"("status", "runAt");

-- CreateIndex
CREATE INDEX "background_job_engagementId_idx" ON "background_job"("engagementId");

-- CreateIndex
CREATE INDEX "background_job_jobType_status_idx" ON "background_job"("jobType", "status");

-- CreateIndex
CREATE INDEX "workflow_event_engagementId_createdAt_idx" ON "workflow_event"("engagementId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_event_engagementId_createdAt_idx" ON "audit_event"("engagementId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_event_userId_createdAt_idx" ON "audit_event"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_event_eventType_idx" ON "audit_event"("eventType");

-- CreateIndex
CREATE INDEX "audit_event_correlationId_idx" ON "audit_event"("correlationId");

-- CreateIndex
CREATE INDEX "audit_event_objectType_objectId_idx" ON "audit_event"("objectType", "objectId");

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_contact" ADD CONSTRAINT "client_contact_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "karbon_work_item" ADD CONSTRAINT "karbon_work_item_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_karbonWorkItemId_fkey" FOREIGN KEY ("karbonWorkItemId") REFERENCES "karbon_work_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "template_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_priorYearEngagementId_fkey" FOREIGN KEY ("priorYearEngagementId") REFERENCES "engagement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_assignedPreparerId_fkey" FOREIGN KEY ("assignedPreparerId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_assignedReviewerId_fkey" FOREIGN KEY ("assignedReviewerId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement" ADD CONSTRAINT "engagement_finalApproverId_fkey" FOREIGN KEY ("finalApproverId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_participant" ADD CONSTRAINT "engagement_participant_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_participant" ADD CONSTRAINT "engagement_participant_clientContactId_fkey" FOREIGN KEY ("clientContactId") REFERENCES "client_contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_version" ADD CONSTRAINT "template_version_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "document_template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_field_definition" ADD CONSTRAINT "template_field_definition_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "template_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_document" ADD CONSTRAINT "source_document_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_document" ADD CONSTRAINT "source_document_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "source_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_coverLetterPackageId_fkey" FOREIGN KEY ("coverLetterPackageId") REFERENCES "cover_letter_package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "template_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_approvedBy_fkey" FOREIGN KEY ("approvedBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_field" ADD CONSTRAINT "extracted_field_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_field" ADD CONSTRAINT "extracted_field_coverLetterPackageId_fkey" FOREIGN KEY ("coverLetterPackageId") REFERENCES "cover_letter_package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_field" ADD CONSTRAINT "extracted_field_confirmedByUserId_fkey" FOREIGN KEY ("confirmedByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_evidence" ADD CONSTRAINT "field_evidence_extractedFieldId_fkey" FOREIGN KEY ("extractedFieldId") REFERENCES "extracted_field"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_evidence" ADD CONSTRAINT "field_evidence_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "source_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_conflict" ADD CONSTRAINT "field_conflict_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_conflict" ADD CONSTRAINT "field_conflict_extractedFieldId_fkey" FOREIGN KEY ("extractedFieldId") REFERENCES "extracted_field"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_conflict" ADD CONSTRAINT "field_conflict_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_selection" ADD CONSTRAINT "service_selection_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_rule" ADD CONSTRAINT "fee_rule_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_calculation" ADD CONSTRAINT "fee_calculation_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_calculation" ADD CONSTRAINT "fee_calculation_feeRuleId_fkey" FOREIGN KEY ("feeRuleId") REFERENCES "fee_rule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_calculation" ADD CONSTRAINT "fee_calculation_calculatedByUserId_fkey" FOREIGN KEY ("calculatedByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calculated_date" ADD CONSTRAINT "calculated_date_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calculated_date" ADD CONSTRAINT "calculated_date_dateRuleId_fkey" FOREIGN KEY ("dateRuleId") REFERENCES "date_rule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calculated_date" ADD CONSTRAINT "calculated_date_confirmedByUserId_fkey" FOREIGN KEY ("confirmedByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_assignment" ADD CONSTRAINT "review_assignment_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_assignment" ADD CONSTRAINT "review_assignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_comment" ADD CONSTRAINT "review_comment_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_comment" ADD CONSTRAINT "review_comment_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "document_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_comment" ADD CONSTRAINT "review_comment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "document_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_coverLetterPackageId_fkey" FOREIGN KEY ("coverLetterPackageId") REFERENCES "cover_letter_package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wording_exception" ADD CONSTRAINT "wording_exception_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wording_exception" ADD CONSTRAINT "wording_exception_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "document_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wording_exception" ADD CONSTRAINT "wording_exception_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wording_exception" ADD CONSTRAINT "wording_exception_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adobe_agreement" ADD CONSTRAINT "adobe_agreement_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adobe_agreement" ADD CONSTRAINT "adobe_agreement_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "document_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adobe_signer" ADD CONSTRAINT "adobe_signer_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "adobe_agreement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adobe_signer" ADD CONSTRAINT "adobe_signer_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "engagement_participant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adobe_event" ADD CONSTRAINT "adobe_event_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "adobe_agreement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cover_letter_package" ADD CONSTRAINT "cover_letter_package_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cover_letter_package" ADD CONSTRAINT "cover_letter_package_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "engagement_participant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "karbon_activity" ADD CONSTRAINT "karbon_activity_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "karbon_activity" ADD CONSTRAINT "karbon_activity_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "document_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "background_job" ADD CONSTRAINT "background_job_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "background_job" ADD CONSTRAINT "background_job_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "document_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_event" ADD CONSTRAINT "workflow_event_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "engagement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
