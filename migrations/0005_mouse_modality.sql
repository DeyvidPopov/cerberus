-- 0005_mouse_modality.sql
-- Project Cerberus — Milestone 10 (continuous authentication, mouse dynamics). ADR-0013.
-- Forward-only migration. Do not edit after it has run anywhere.
--
-- Mouse dynamics is a SECOND behavioral modality that REUSES the M6 enrollment
-- lifecycle and the M7 Mahalanobis scorer (modality-agnostic). A user therefore has
-- one baseline PER modality, so the behavioral tables gain a `modality` discriminator
-- and the per-user baseline uniqueness becomes per (user, modality, model_version).
-- Existing rows are keystroke (the column DEFAULT), so this is backward-compatible.

ALTER TABLE behavioral_baselines
    ADD COLUMN modality TEXT NOT NULL DEFAULT 'keystroke'
    CHECK (modality IN ('keystroke','mouse'));

ALTER TABLE enrollment_samples
    ADD COLUMN modality TEXT NOT NULL DEFAULT 'keystroke'
    CHECK (modality IN ('keystroke','mouse'));

-- One active baseline per (user, modality): keystroke and mouse no longer collide
-- on the (user_id, model_version) uniqueness, and ON CONFLICT upserts the right row.
ALTER TABLE behavioral_baselines DROP CONSTRAINT behavioral_baselines_user_id_model_version_key;
ALTER TABLE behavioral_baselines
    ADD CONSTRAINT behavioral_baselines_user_modality_version_key
    UNIQUE (user_id, modality, model_version);

DROP INDEX idx_baselines_user_active;
CREATE INDEX idx_baselines_user_modality_active
    ON behavioral_baselines(user_id, modality) WHERE status = 'active';

CREATE INDEX idx_enrollment_user_modality ON enrollment_samples(user_id, modality);
