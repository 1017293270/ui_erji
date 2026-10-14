-- Liveness of the long-running processes (the worker beats every 30 s); /healthz reads it.
create table heartbeats (
  name text primary key,
  beat_at timestamptz not null default now()
);
