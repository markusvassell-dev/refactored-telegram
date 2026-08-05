-- A source document can be replaced while a cover letter is still waiting in
-- the review queue. Stale detection must be able to send it back for changes
-- from COVER_LETTER_REVIEW_REQUIRED, not only from COVER_LETTER_IN_REVIEW.

INSERT INTO "workflow_transition" ("fromStatus", "toStatus") VALUES
  ('COVER_LETTER_REVIEW_REQUIRED', 'COVER_LETTER_CHANGES_REQUESTED')
ON CONFLICT DO NOTHING;
