-- The commissioner's notes: a league's own house rules in its commissioner's words
-- (buy-in, prizes, payouts, anything the rule settings don't cover), shown at the top
-- of the league's Rules page to every member. Plain text; the site shows it as written.

alter table public.leagues
  add column notes text not null default '' check (length(notes) <= 4000),
  add column notes_updated_at timestamptz;

-- Members read them with the rest of the league's row.
grant select (notes, notes_updated_at) on public.leagues to authenticated;

-- Replaces the notes. Like every commissioner action, it's in the admin log, old and new
-- text both, so members can see what changed.
create or replace function public.admin_set_league_notes(p_league uuid, p_notes text) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_actor uuid := app.require_commissioner(p_league); v_before text; v_notes text := coalesce(trim(p_notes), '');
begin
  if length(v_notes) > 4000 then raise exception 'notes_too_long'; end if;
  select notes into v_before from public.leagues where id = p_league for update;
  if v_before = v_notes then return; end if;
  update public.leagues set notes = v_notes, notes_updated_at = now() where id = p_league;
  perform app.audit(v_actor, 'notes_updated', 'league', p_league::text,
    jsonb_build_object('notes', v_before), jsonb_build_object('notes', v_notes), null, p_league);
end $$;

revoke execute on function public.admin_set_league_notes(uuid, text) from public, anon;
grant execute on function public.admin_set_league_notes(uuid, text) to authenticated;
