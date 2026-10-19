-- Issue #1283: Persist enterprise rate-limit tier configuration in Prisma
-- Creates _enterprise_tier_configs and backfills existing rows from _rate_limit_overrides

CREATE TABLE IF NOT EXISTS "_enterprise_tier_configs" (
  "id" TEXT NOT NULL,
  "org_id" VARCHAR(128) NOT NULL,
  "max_per_minute" INTEGER NOT NULL,
  "max_burst" INTEGER NOT NULL,
  "window_ms" INTEGER NOT NULL DEFAULT 60000,
  "label" VARCHAR(128) NOT NULL,
  "feature_flags" TEXT[] NOT NULL DEFAULT '{}',
  "grace_degradation" VARCHAR(32) NOT NULL DEFAULT 'fallback',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "_enterprise_tier_configs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "_enterprise_tier_configs_org_id_key" UNIQUE ("org_id")
);

CREATE INDEX IF NOT EXISTS "_enterprise_tier_configs_org_id_idx" ON "_enterprise_tier_configs"("org_id");

-- Backfill from existing _rate_limit_overrides where identifier starts with 'ent:'
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '_rate_limit_overrides') THEN
    INSERT INTO "_enterprise_tier_configs" (
      "id",
      "org_id",
      "max_per_minute",
      "max_burst",
      "window_ms",
      "label",
      "feature_flags",
      "grace_degradation",
      "created_at",
      "updated_at"
    )
    SELECT
      gen_random_uuid()::text,
      SUBSTRING("identifier" FROM 5),
      "max",
      COALESCE(("endpoint"::jsonb->>'maxBurst')::integer, 20000),
      COALESCE("window_ms", 60000),
      COALESCE("endpoint"::jsonb->>'label', 'enterprise-custom'),
      COALESCE(
        ARRAY(SELECT jsonb_array_elements_text(COALESCE("endpoint"::jsonb->'featureFlags', '[]'::jsonb))),
        '{}'::text[]
      ),
      COALESCE("endpoint"::jsonb->>'graceDegradation', 'fallback'),
      "created_at",
      "updated_at"
    FROM "_rate_limit_overrides"
    WHERE "identifier" LIKE 'ent:%'
    ON CONFLICT ("org_id") DO NOTHING;
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    NULL;
END $$;
