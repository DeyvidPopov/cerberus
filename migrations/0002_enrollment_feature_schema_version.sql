-- 0002_enrollment_feature_schema_version.sql
-- Project Cerberus — Milestone 6 (keystroke capture + enrollment). ADR-0009.
-- Forward-only migration. Do not edit after it has run anywhere.
--
-- Stamp every ephemeral enrollment sample with the feature-schema version it was
-- captured under, so the baseline fit never mixes vectors from incompatible
-- extractor definitions. The behavioral_baselines and enrollment_samples tables
-- themselves already exist (0001); this only adds the version column.
--
-- The default mirrors @cerberus/shared-types FEATURE_SCHEMA_VERSION (= 1); the
-- application always supplies the value explicitly. SQL cannot import the TS
-- constant, so the two are kept in sync by hand (ADR-0009).

ALTER TABLE enrollment_samples
    ADD COLUMN feature_schema_version INTEGER NOT NULL DEFAULT 1;
