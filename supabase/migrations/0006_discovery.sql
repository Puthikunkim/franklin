-- Slice 4: discovery. Search over live auctions, plus a per-dealer watchlist.

-- ── Read: search/filter/sort over LIVE auctions ────────────────────────────────
-- Each param is optional (null / empty = no filter). Returns setof auctions so
-- callers re-join vehicle + seller with the existing pattern. security invoker:
-- anon already has SELECT on auctions/vehicles/dealers, so no privilege escalation.
create or replace function search_live_auctions(
  p_q text default null,
  p_grades vehicle_grade[] default null,
  p_min_price int default null,
  p_max_price int default null,
  p_region text default null,
  p_sort text default null
) returns setof auctions
language sql stable security invoker as $$
  select a.*
  from auctions a
  join vehicles v on v.id = a.vehicle_id
  join dealers d on d.id = a.seller_dealer_id
  where a.status = 'live'
    and (p_q is null or p_q = '' or
         v.make ilike '%' || p_q || '%' or
         v.model ilike '%' || p_q || '%' or
         coalesce(v.variant, '') ilike '%' || p_q || '%')
    and (p_grades is null or array_length(p_grades, 1) is null or v.grade = any(p_grades))
    and (p_min_price is null or coalesce(a.current_bid, a.starting_price) >= p_min_price)
    and (p_max_price is null or coalesce(a.current_bid, a.starting_price) <= p_max_price)
    and (p_region is null or p_region = '' or d.region = p_region)
  order by
    case when p_sort = 'price_asc'  then coalesce(a.current_bid, a.starting_price) end asc,
    case when p_sort = 'price_desc' then coalesce(a.current_bid, a.starting_price) end desc,
    case when p_sort = 'newest'     then a.start_time end desc,
    a.end_time asc;  -- default (ending_soon) and deterministic tiebreaker for all sorts
$$;

grant execute on function search_live_auctions(text, vehicle_grade[], int, int, text, text)
  to anon, authenticated;

-- ── Watchlist table ────────────────────────────────────────────────────────────
create table watchlist (
  dealer_id  uuid not null references dealers(id),
  auction_id uuid not null references auctions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (dealer_id, auction_id)
);

grant select on watchlist to anon, authenticated;
grant select, insert, update, delete on watchlist to service_role;

-- ── Write: toggle a watch. service_role only. ──────────────────────────────────
create or replace function set_watch(p_dealer_id uuid, p_auction_id uuid, p_watched boolean)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_watched then
    insert into watchlist (dealer_id, auction_id) values (p_dealer_id, p_auction_id)
    on conflict do nothing;
  else
    delete from watchlist where dealer_id = p_dealer_id and auction_id = p_auction_id;
  end if;
  return p_watched;
end; $$;

-- Writer is service-role only (Slice 2/3 pattern): revoke the PUBLIC default first.
revoke execute on function set_watch(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function set_watch(uuid, uuid, boolean) to service_role;

-- ── Fix: test_reset() must not clobber draft listings ──────────────────────────
-- The original test_reset() (0002) does `update auctions set status = 'live' ...
-- where true`, unconditionally flipping EVERY auction -- including seeded/created
-- drafts -- to 'live'. That silently breaks any test that asserts a draft stays a
-- draft across a reset (e.g. discovery's "never returns a non-live auction" test,
-- which checks the seeded draft a0000000-0000-0000-0000-0000000000d1 is excluded
-- from search_live_auctions results). It also meant dashboard.test.ts's
-- `resetDb(); cleanupDrafts();` pattern could never actually clean up a
-- previous test's leftover draft: resetDb() already promoted it to 'live' before
-- cleanupDrafts() looked for status = 'draft'. Scoping the reset to non-draft
-- rows fixes both: drafts keep their identity across resets, and cleanupDrafts()
-- can find and remove them as intended.
create or replace function test_reset() returns void language plpgsql security definer as $$
begin
  truncate bids restart identity cascade;
  truncate settlements restart identity cascade;
  update auctions
    set current_bid = null,
        current_winner_dealer_id = null,
        status = 'live',
        end_time = now() + interval '2 hours'
  where status <> 'draft';
end;
$$;
