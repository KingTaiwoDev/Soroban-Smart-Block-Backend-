-- Issue #1252: Record provenance and trust level for contract metadata submissions
-- Adds provenance and trust_level columns to _contracts, _contract_networks, and _contract_abi_submissions

ALTER TABLE "_contracts"
  ADD COLUMN IF NOT EXISTS "provenance" JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "trust_level" VARCHAR(32) DEFAULT 'unverified';

ALTER TABLE "_contract_networks"
  ADD COLUMN IF NOT EXISTS "provenance" JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "trust_level" VARCHAR(32) DEFAULT 'unverified';

ALTER TABLE "_contract_abi_submissions"
  ADD COLUMN IF NOT EXISTS "provenance" JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "trust_level" VARCHAR(32) NOT NULL DEFAULT 'community';

CREATE INDEX IF NOT EXISTS "_contracts_trust_level_idx" ON "_contracts"("trust_level");
CREATE INDEX IF NOT EXISTS "_contract_networks_trust_level_idx" ON "_contract_networks"("trust_level");
CREATE INDEX IF NOT EXISTS "_contract_abi_submissions_trust_level_idx" ON "_contract_abi_submissions"("trust_level");
