-- The transitions DELIVERED takes part in.
--
-- Separate from the migration that adds the enum value, and it has to be:
-- Postgres refuses to *use* a new enum value inside the same transaction that
-- added it ("unsafe use of new value of enum type"). Prisma runs each
-- migration in its own transaction, so the split is what makes both apply.
--
-- The application enforces these in packages/workflows and a database trigger
-- enforces them again from this table, so an illegal transition is refused
-- even by something that never went through the application.

INSERT INTO "workflow_transition" ("fromStatus", "toStatus") VALUES
  ('NEEDS_ATTENTION', 'DELIVERED'),
  ('READY_FOR_DELIVERY', 'DELIVERED'),
  ('DELIVERED', 'COVER_LETTER_CHANGES_REQUESTED'),
  ('DELIVERED', 'NEEDS_ATTENTION')
ON CONFLICT DO NOTHING;
