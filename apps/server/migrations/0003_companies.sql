-- Companies are added on the desktop's 公司管理 page, each with its own self-built Feishu app.
-- The App Secret is AES-256-GCM sealed with ECHOMIND_DATA_KEY. People pick their company with
-- its join code before signing in; a disabled company's sessions stop working.
alter table tenants
  add column name text,
  add column feishu_app_secret bytea,
  add column join_code text unique,
  add column disabled_at timestamptz;

-- The app from .env is taken in at start-up and learns its tenant at the first sign-in.
alter table tenants alter column feishu_tenant_key drop not null;
