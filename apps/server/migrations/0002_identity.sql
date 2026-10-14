-- A company on EchoMind: one Feishu tenant, reached through one self-built app.
create table tenants (
  id uuid primary key default gen_random_uuid(),
  feishu_app_id text not null unique,
  feishu_tenant_key text not null unique,
  timezone text not null default 'Asia/Shanghai',
  directory_synced_at timestamptz,
  created_at timestamptz not null default now()
);

-- Everyone EchoMind knows in a tenant: from the directory, or from signing in.
-- `listed` means the last directory walk returned them; ids outside EchoMind stay open_ids.
create table people (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id),
  open_id text not null,
  name text not null,
  department text,
  title text,
  aliases text[] not null default '{}',
  listed boolean not null default false,
  sort_order integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (tenant_id, open_id)
);

-- A person's Feishu user token, so EchoMind can act as them with their computer off.
-- Tokens are AES-256-GCM sealed with ECHOMIND_DATA_KEY. `revoked_at`: Feishu refused the
-- refresh token; the person has to sign in again.
create table feishu_grants (
  person_id uuid primary key references people (id),
  access_token bytea not null,
  access_expires_at timestamptz not null,
  refresh_token bytea,
  refresh_expires_at timestamptz,
  scopes text not null default '',
  updated_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- A signed-in desktop app. Only the SHA-256 of the token is kept.
create table sessions (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people (id),
  token_hash bytea not null unique,
  device text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index sessions_person on sessions (person_id);
