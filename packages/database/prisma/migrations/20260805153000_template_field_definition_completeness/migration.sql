-- Completes the field-definition projection of a template manifest.
--
-- These four properties existed only inside the manifest JSON, which meant the
-- review UI could not render a correct input for a field without re-parsing the
-- manifest: it did not know an ENUM's permitted values, a field's length limit,
-- which conditional section makes a field mandatory, or what bracketed text the
-- token replaced in the approved letter.

ALTER TABLE "template_field_definition"
  ADD COLUMN "sourcePlaceholder"   TEXT,
  ADD COLUMN "enumValues"          TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "maxLength"           INTEGER,
  ADD COLUMN "requiredWhenSection" TEXT;

-- Backfill from the manifest already stored against each template version, so
-- an existing deployment does not need to be re-seeded. A published template
-- version is immutable; this reads it and writes only the projection.
UPDATE "template_field_definition" AS d
   SET "sourcePlaceholder"   = f."sourcePlaceholder",
       "enumValues"          = f."enumValues",
       "maxLength"           = f."maxLength",
       "requiredWhenSection" = f."requiredWhenSection"
  FROM (
    SELECT v."id"                          AS "versionId",
           field ->> 'token'               AS "token",
           field ->> 'sourcePlaceholder'   AS "sourcePlaceholder",
           CASE
             WHEN jsonb_typeof(field -> 'enumValues') = 'array'
               THEN ARRAY(SELECT jsonb_array_elements_text(field -> 'enumValues'))
             ELSE ARRAY[]::TEXT[]
           END                             AS "enumValues",
           NULLIF(field ->> 'maxLength', '')::INTEGER AS "maxLength",
           field ->> 'requiredWhenSection' AS "requiredWhenSection"
      FROM "template_version" AS v,
           LATERAL jsonb_array_elements(v."manifest" -> 'fields') AS field
     WHERE jsonb_typeof(v."manifest" -> 'fields') = 'array'
  ) AS f
 WHERE d."templateVersionId" = f."versionId"
   AND d."token" = f."token";
