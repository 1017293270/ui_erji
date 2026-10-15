-- A person's voiceprint, kept only with their consent. `status`: a consent card was sent
-- (asked), or they answered it (agreed / declined); agreeing in the app counts too. `vector` is
-- the mean of the voice samples EchoMind was allowed to keep (float32, AES-256-GCM sealed with
-- ECHOMIND_DATA_KEY); it stays null until the first sample arrives. Deleting a voiceprint
-- deletes the row, consent included.
create table voiceprints (
  person_id uuid primary key references people (id),
  status text not null check (status in ('asked', 'agreed', 'declined')),
  asked_by uuid references people (id),
  asked_at timestamptz,
  -- The consent card in the person's chat with the bot, to show its new state elsewhere.
  card_message_id text,
  answered_at timestamptz,
  vector bytea,
  samples integer not null default 0,
  seconds real not null default 0,
  updated_at timestamptz not null default now()
);
