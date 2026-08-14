-- The signature copy of a rendered document.
--
-- A person approves a readable draft; Adobe needs the same document carrying
-- signature tags. Those are two different files, and until now only the draft
-- existed -- `sendForSignature` uploaded it verbatim, so the document sent for
-- signature had no signature fields in it at all.
--
-- Both copies are rendered from the same values in the same operation, so they
-- cannot drift. Rendering the tagged copy at send time instead would produce
-- bytes nobody approved, and proving after the fact that they match the
-- approved draft is harder than never letting them diverge.
--
-- Nullable because every version rendered before this migration has no
-- signature copy, and because cover letters are never sent for signature.

ALTER TABLE "document_version" ADD COLUMN "signaturePdfReference" TEXT;
ALTER TABLE "document_version" ADD COLUMN "signaturePdfHash" TEXT;
