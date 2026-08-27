-- A notice of assessment is the single most useful CRA source for a business
-- number, a year-end and a balance owing, and had no kind of its own: it landed
-- under OTHER_SUPPORTING_SCHEDULE, where nothing could tell it apart from a
-- depreciation working paper.
--
-- Additive only. No existing row changes, and nothing is reclassified: a
-- document already filed as OTHER_SUPPORTING_SCHEDULE stays there until
-- something reads it again.
ALTER TYPE "SourceDocumentKind" ADD VALUE IF NOT EXISTS 'NOTICE_OF_ASSESSMENT';
