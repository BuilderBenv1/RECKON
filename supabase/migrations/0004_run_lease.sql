-- One action at a time per run. A request takes a short lease on its run before acting and
-- releases it after saving, so two requests (a poll and a webhook, say) can't both pay a bill.
alter table public.reckon_runs add column if not exists lease_token text;
alter table public.reckon_runs add column if not exists lease_until timestamptz;

-- History should record saved versions only, not lease changes.
drop trigger if exists reckon_runs_history on public.reckon_runs;
drop trigger if exists reckon_runs_history_insert on public.reckon_runs;
drop trigger if exists reckon_runs_history_update on public.reckon_runs;
create trigger reckon_runs_history_insert after insert on public.reckon_runs
for each row when (new.mode = 'live') execute function public.reckon_capture_run_version();
create trigger reckon_runs_history_update after update on public.reckon_runs
for each row when (new.mode = 'live' and new.version is distinct from old.version) execute function public.reckon_capture_run_version();
