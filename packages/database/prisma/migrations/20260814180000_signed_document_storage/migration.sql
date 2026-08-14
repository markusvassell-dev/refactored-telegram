-- Keep the signed document, not just a record that it was uploaded.
--
-- The retrieval downloaded the signed PDF and the Adobe audit report, hashed
-- them, pushed them to Karbon and discarded the bytes. If the Karbon upload
-- failed, or the engagement had no linked work item, nothing was kept: the one
-- document proving a client accepted a fee existed nowhere.

ALTER TABLE "adobe_agreement" ADD COLUMN "signedPdfReference" TEXT;
ALTER TABLE "adobe_agreement" ADD COLUMN "certificateReference" TEXT;
