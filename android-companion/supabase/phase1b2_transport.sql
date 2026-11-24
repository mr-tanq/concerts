-- =====================================================================
-- Listening Mirror — Phase 1B-2 transport backend
-- Complete, self-contained, reproducible. Applied to project
-- lsnhmthhtjinyidnojiq; this file is the canonical, auditable source and
-- is sufficient to recreate the backend from scratch.
--
-- Design in one line: the transport tables live in an unexposed `private`
-- schema with no grants and RLS on, and the ONLY reachable surface is two
-- SECURITY DEFINER functions that each require a caller-supplied secret.
-- =====================================================================

-- Requires pgcrypto (Supabase installs it into the `extensions` schema).
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;

-- ---------------------------------------------------------------------
-- 1. Private schema — never added to PostgREST's exposed schemas.
-- ---------------------------------------------------------------------
create schema if not exists private;

revoke all   on schema private from anon, authenticated;
revoke usage on schema private from public;

-- ---------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------

-- One row per transport credential. Secrets are stored ONLY as bcrypt
-- hashes; the plaintext exists only in the two clients.
create table if not exists private.transport_devices (
  id          uuid primary key default extensions.uuid_generate_v4(),
  label       text        not null,
  secret_hash text        not null,
  capability  text        not null check (capability in ('write','read')),
  owner_id    uuid        not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

-- owner_id as PRIMARY KEY makes "latest state only" structural: there is
-- physically one row, so listening history cannot accumulate even by
-- accident. `state` is nullable and NULL is meaningful — it is the explicit
-- representation of "Android has no selected playing session".
create table if not exists private.current_playback (
  owner_id       uuid        primary key references auth.users(id) on delete cascade,
  schema_version int         not null,
  device_id      text        not null,
  sequence       bigint      not null,
  state          jsonb,
  captured_at    timestamptz not null,                -- Android clock, diagnostic only
  received_at    timestamptz not null default now(),  -- relay clock, authoritative for freshness
  updated_at     timestamptz not null default now()
);

-- Defence in depth: no direct CRUD even if the schema were ever exposed.
revoke all on all tables in schema private from anon, authenticated, public;

-- Third layer: RLS enabled with ZERO policies denies every non-owner,
-- non-superuser access outright. Intentional — the definer functions below
-- are the only intended path, so there is nothing to write a policy for.
alter table private.transport_devices enable row level security;
alter table private.current_playback  enable row level security;

-- ---------------------------------------------------------------------
-- 3. publish_playback — the only write surface
--
-- ORDERING IS ATOMIC. The accept decision lives INSIDE the upsert's
-- ON CONFLICT ... WHERE, not in a separate read-then-decide step.
--
-- The naive shape (SELECT -> decide -> unconditional upsert) is TOCTOU
-- racy: two concurrent requests can both read sequence 9, both decide
-- "accept", and the slower writer can land last carrying the LOWER
-- sequence -- silently violating monotonicity. Postgres evaluates the
-- ON CONFLICT predicate while holding the conflicting row's lock, after
-- any concurrent transaction on that row has committed, so the comparison
-- is always against the CURRENT stored sequence. The pre-read below is
-- therefore purely diagnostic and cannot influence acceptance.
-- ---------------------------------------------------------------------
create or replace function public.publish_playback(
  p_secret         text,
  p_schema_version int,
  p_device_id      text,
  p_sequence       bigint,
  p_state          jsonb,
  p_captured_at    timestamptz,
  p_takeover       boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner    uuid;
  v_existing private.current_playback%rowtype;
  v_written  int;
  v_reason   text;
begin
  -- Secret + capability + revocation validated in one lookup.
  select d.owner_id into v_owner
  from private.transport_devices d
  where d.capability = 'write'
    and d.revoked_at is null
    and d.secret_hash = extensions.crypt(p_secret, d.secret_hash)
  limit 1;

  if v_owner is null then
    return jsonb_build_object('accepted', false, 'reason', 'invalid_secret');
  end if;

  -- Diagnostic only. Under concurrency this snapshot may already be out of
  -- date by the time the upsert runs -- which is exactly why it no longer
  -- gates anything.
  select * into v_existing from private.current_playback c where c.owner_id = v_owner;

  insert into private.current_playback as c
    (owner_id, schema_version, device_id, sequence, state, captured_at, received_at, updated_at)
  values
    (v_owner, p_schema_version, p_device_id, p_sequence, p_state, p_captured_at, now(), now())
  on conflict (owner_id) do update set
    schema_version = excluded.schema_version,
    device_id      = excluded.device_id,
    sequence       = excluded.sequence,
    state          = excluded.state,
    captured_at    = excluded.captured_at,
    received_at    = now(),   -- relay clock, never the client's
    updated_at     = now()
  where
    -- Same device: strictly monotonic, against the LOCKED current row.
    (c.device_id = excluded.device_id and excluded.sequence > c.sequence)
    -- Different device: explicit takeover, or the stored row already stale.
    or (c.device_id <> excluded.device_id
        and (p_takeover or c.received_at < now() - interval '60 seconds'));

  get diagnostics v_written = row_count;

  if v_written > 0 then
    if v_existing.owner_id is null then
      v_reason := 'first_write';
    elsif v_existing.device_id <> p_device_id then
      v_reason := case when p_takeover then 'explicit_takeover' else 'stale_row_takeover' end;
    else
      v_reason := 'newer_sequence';
    end if;
    return jsonb_build_object('accepted', true, 'reason', v_reason);
  end if;

  -- Rejected by the atomic predicate. Re-read so the reported reason
  -- reflects the row that actually won, not our stale pre-read.
  select * into v_existing from private.current_playback c where c.owner_id = v_owner;
  if v_existing.owner_id is null then
    v_reason := 'rejected';
  elsif v_existing.device_id = p_device_id then
    v_reason := 'stale_sequence';
  else
    v_reason := 'active_other_device';
  end if;
  return jsonb_build_object('accepted', false, 'reason', v_reason);
end;
$$;

-- ---------------------------------------------------------------------
-- 4. read_playback — the only read surface
-- ---------------------------------------------------------------------
create or replace function public.read_playback(p_secret text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_row   private.current_playback%rowtype;
begin
  select d.owner_id into v_owner
  from private.transport_devices d
  where d.capability = 'read'
    and d.revoked_at is null
    and d.secret_hash = extensions.crypt(p_secret, d.secret_hash)
  limit 1;

  if v_owner is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_secret');
  end if;

  select * into v_row from private.current_playback c where c.owner_id = v_owner;

  -- relay_now is returned alongside received_at deliberately: both come from
  -- this same clock, giving the web a skew-free age for position compensation.
  if v_row.owner_id is null then
    return jsonb_build_object('ok', true, 'relay_now', now(), 'present', false);
  end if;

  return jsonb_build_object(
    'ok', true,
    'relay_now', now(),
    'present', true,
    'schema_version', v_row.schema_version,
    'device_id', v_row.device_id,
    'sequence', v_row.sequence,
    'state', v_row.state,
    'captured_at', v_row.captured_at,
    'received_at', v_row.received_at
  );
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Explicit privileges — never rely on PostgreSQL defaults.
--    anon-only by design: neither client holds a Supabase Auth session,
--    and the transport secret is the application-level authorization
--    boundary. Supabase re-grants to `authenticated` by default, so that
--    is revoked explicitly too.
-- ---------------------------------------------------------------------
revoke execute on function public.publish_playback(text,int,text,bigint,jsonb,timestamptz,boolean) from public;
revoke execute on function public.publish_playback(text,int,text,bigint,jsonb,timestamptz,boolean) from authenticated;
grant  execute on function public.publish_playback(text,int,text,bigint,jsonb,timestamptz,boolean) to   anon;

revoke execute on function public.read_playback(text) from public;
revoke execute on function public.read_playback(text) from authenticated;
grant  execute on function public.read_playback(text) to   anon;

-- ---------------------------------------------------------------------
-- 6. Credential management (plaintext never stored)
-- ---------------------------------------------------------------------
-- Create:
--   insert into private.transport_devices (label, secret_hash, capability, owner_id)
--   select '<label>',
--          extensions.crypt('<plaintext-secret>', extensions.gen_salt('bf', 10)),
--          '<write|read>',
--          u.id
--   from auth.users u order by u.created_at limit 1;
--
-- Revoke (takes effect immediately; both RPCs filter on revoked_at is null):
--   update private.transport_devices set revoked_at = now() where label = '<label>';
--
-- Clear current state manually:
--   delete from private.current_playback;
