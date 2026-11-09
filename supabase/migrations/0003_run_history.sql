-- Keeps every saved version of a live run (reckon_runs keeps only the latest), so a live
-- sandbox run can be replayed step by step afterwards, e.g. to render the demo video.
create table if not exists public.reckon_run_history (
  id bigserial primary key,
  run_id uuid not null,
  version integer not null,
  mode text not null,
  refs text[] not null default '{}',
  data jsonb not null,
  saved_at timestamptz not null default now()
);
create index if not exists reckon_run_history_run_idx on public.reckon_run_history (run_id, version);
alter table public.reckon_run_history enable row level security;

create or replace function public.reckon_capture_run_version() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.reckon_run_history (run_id, version, mode, refs, data)
  values (new.id, new.version, new.mode, new.refs, new.data);
  return new;
end;
$$;
revoke all on function public.reckon_capture_run_version() from public, anon, authenticated;

drop trigger if exists reckon_runs_history on public.reckon_runs;
create trigger reckon_runs_history after insert or update on public.reckon_runs
for each row when (new.mode = 'live') execute function public.reckon_capture_run_version();
