-- M1: PostgreSQL Row Level Security — the database-level tenant backstop
-- (ARCHITECTURE §3, invariant I2).
--
-- Model: the app connects as the schema owner for platform operations
-- (install, uninstall, GDPR erasure, migrations). Tenant-scoped data-plane
-- access goes through `withStoreScope()`, which assumes the `profit_app`
-- role and pins `app.store_id` inside the same transaction. Policies are
-- therefore registered FOR ROLE profit_app:
--   - owner connections (platform ops) are unaffected;
--   - profit_app connections physically cannot read/write another tenant,
--     even if application code forgets a WHERE clause;
--   - any future dedicated app login gets the same guarantee automatically.
--
-- current_setting('app.store_id', true) returns '' when unset; the nullif()
-- cast then yields NULL and the policy matches nothing (fail closed).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'profit_app') THEN
    CREATE ROLE profit_app NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO profit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO profit_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO profit_app;

-- Tenant root: a scoped connection may only see its own store row.
ALTER TABLE "stores" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation_stores" ON "stores";
CREATE POLICY "tenant_isolation_stores" ON "stores"
  FOR ALL TO profit_app
  USING ("id" = nullif(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK ("id" = nullif(current_setting('app.store_id', true), '')::uuid);

-- All tenant business tables share one policy shape on store_id.
DO $$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'store_settings',
    'subscriptions',
    'user_store_memberships',
    'sessions',
    'api_keys',
    'shopify_sessions',
    'webhook_logs',
    'sync_history',
    'audit_logs',
    'background_jobs',
    'failed_jobs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'tenant_isolation_' || tenant_table, tenant_table);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO profit_app
         USING (store_id = nullif(current_setting(''app.store_id'', true), '''')::uuid)
         WITH CHECK (store_id = nullif(current_setting(''app.store_id'', true), '''')::uuid)',
      'tenant_isolation_' || tenant_table,
      tenant_table
    );
  END LOOP;
END $$;

-- refresh_tokens / job_retries carry no store_id by design; isolation is
-- inherited from the parent row (sessions / background_jobs, which are
-- themselves policy-filtered under the same scope).
ALTER TABLE "refresh_tokens" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation_refresh_tokens" ON "refresh_tokens";
CREATE POLICY "tenant_isolation_refresh_tokens" ON "refresh_tokens"
  FOR ALL TO profit_app
  USING (EXISTS (
    SELECT 1 FROM "sessions" s
    WHERE s.id = session_id
      AND s.store_id = nullif(current_setting('app.store_id', true), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "sessions" s
    WHERE s.id = session_id
      AND s.store_id = nullif(current_setting('app.store_id', true), '')::uuid
  ));

ALTER TABLE "job_retries" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation_job_retries" ON "job_retries";
CREATE POLICY "tenant_isolation_job_retries" ON "job_retries"
  FOR ALL TO profit_app
  USING (EXISTS (
    SELECT 1 FROM "background_jobs" bj
    WHERE bj.id = job_id
      AND bj.store_id = nullif(current_setting('app.store_id', true), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "background_jobs" bj
    WHERE bj.id = job_id
      AND bj.store_id = nullif(current_setting('app.store_id', true), '')::uuid
  ));

-- Non-tenant tables intentionally WITHOUT policies (documented exceptions):
--   plans, roles, permissions, role_permissions  → platform-shared catalogs;
--   users                                       → m:n identities, scoped via memberships at app layer;
--   shopify_oauth_states                        → pre-install states (no store exists yet).
