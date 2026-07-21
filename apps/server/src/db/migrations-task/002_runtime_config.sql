-- Per-task DB model profile snapshots.

ALTER TABLE seats ADD COLUMN model_override TEXT;
ALTER TABLE agents ADD COLUMN model_profile TEXT;
