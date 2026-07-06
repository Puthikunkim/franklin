-- Slice 8: auto-close. Resolve auctions whose timer has run out without depending on a
-- /won/[id] visit. close_expired_auctions() batches over expired live auctions and calls the
-- existing close_auction(id) for each, so sold/passed + settlement + won/sold notifications
-- stay defined in ONE place (close_auction). search_live_auctions gains a defensive end_time
-- filter so an expired auction is never shown as bidable, independent of the sweep.

create or replace function close_expired_auctions() returns int
language plpgsql security definer set search_path = public as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select id from auctions
    where status = 'live' and end_time <= now()
    for update skip locked        -- don't block on an in-flight bid or a concurrent sweep
  loop
    perform close_auction(r.id);   -- reuse reserve→sold+settlement+won/sold notifs, else passed
    n := n + 1;
  end loop;
  return n;
end; $$;

-- System operation (no dealer identity, idempotent, only advances genuinely-expired auctions):
-- anon/authenticated-callable, mirroring close_auction. The home/dashboard server components
-- invoke it via the anon client during render. PUBLIC's default execute is intentionally left
-- in place (as with close_auction).
grant execute on function close_expired_auctions() to anon, authenticated;

-- Redefine search_live_auctions (originally 0006) with a defensive end_time > now() filter.
-- All other clauses, the ordering, and (via CREATE OR REPLACE) the 0006 grant to
-- anon/authenticated are preserved verbatim.
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
    and a.end_time > now()
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
