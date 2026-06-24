-- ── Test helpers (local/demo only; safe because no real auth in this slice) ──

create or replace function test_reset() returns void language plpgsql security definer as $$
begin
  truncate bids restart identity cascade;
  truncate settlements restart identity cascade;
  update auctions
    set current_bid = null,
        current_winner_dealer_id = null,
        status = 'live',
        end_time = now() + interval '2 hours'
  where true;
end;
$$;

create or replace function test_set_end_in_seconds(p_auction_id uuid, p_seconds int)
returns void language sql security definer
set search_path = public as $$
  update auctions
    set end_time = now() + make_interval(secs => p_seconds)
  where id = p_auction_id;
$$;

-- ── Core bid engine ───────────────────────────────────────────────────────────

create or replace function place_bid(
  p_auction_id  uuid,
  p_dealer_id   uuid,
  p_max_amount  int
)
returns table (
  status                    text,
  reason                    text,
  current_bid               int,
  current_winner_dealer_id  uuid,
  end_time                  timestamptz
)
language plpgsql security definer
set search_path = public as $$
declare
  a             auctions%rowtype;
  v_min         int;
  v_leader_max  int;
  v_new_price   int;
  v_new_winner  uuid;
begin
  -- Lock the auction row for the duration of this transaction (atomic)
  select * into a from auctions where id = p_auction_id for update;

  -- Guard: ended
  if a.status <> 'live' or a.end_time <= now() then
    return query select
      'rejected'::text,
      'auction_ended'::text,
      a.current_bid,
      a.current_winner_dealer_id,
      a.end_time;
    return;
  end if;

  -- Minimum max_amount this bid must meet
  if a.current_bid is null then
    v_min := a.starting_price;
  else
    v_min := a.current_bid + a.bid_increment;
  end if;

  if p_max_amount < v_min then
    return query select
      'rejected'::text,
      'below_minimum'::text,
      a.current_bid,
      a.current_winner_dealer_id,
      a.end_time;
    return;
  end if;

  -- Current leader's highest proxy ceiling
  select max(max_amount) into v_leader_max
    from bids
   where auction_id = p_auction_id
     and bidder_dealer_id = a.current_winner_dealer_id;

  -- Determine new price and winner
  if a.current_winner_dealer_id is null then
    -- No bids yet: open at starting price
    v_new_price  := a.starting_price;
    v_new_winner := p_dealer_id;

  elsif p_dealer_id = a.current_winner_dealer_id then
    -- Same dealer raising their proxy ceiling: price unchanged
    v_new_price  := a.current_bid;
    v_new_winner := p_dealer_id;

  elsif p_max_amount > coalesce(v_leader_max, a.current_bid) then
    -- Challenger beats leader's proxy: price = loser_max + increment (capped at challenger's max)
    v_new_price  := least(
                      coalesce(v_leader_max, a.current_bid) + a.bid_increment,
                      p_max_amount
                    );
    v_new_winner := p_dealer_id;

  else
    -- Leader's proxy holds: price rises to challenger_max + increment (capped at leader's proxy)
    v_new_price  := least(p_max_amount + a.bid_increment, v_leader_max);
    v_new_winner := a.current_winner_dealer_id;
  end if;

  -- Record the bid
  insert into bids (auction_id, bidder_dealer_id, amount, max_amount)
    values (p_auction_id, p_dealer_id, v_new_price, p_max_amount);

  -- Anti-snipe: extend end_time if bid lands inside the window
  if a.end_time - now() <= make_interval(secs => a.anti_snipe_seconds) then
    a.end_time := a.end_time + make_interval(secs => a.anti_snipe_seconds);
  end if;

  -- Persist auction state
  update auctions
     set current_bid              = v_new_price,
         current_winner_dealer_id = v_new_winner,
         end_time                 = a.end_time
   where id = p_auction_id;

  return query select
    'accepted'::text,
    null::text,
    v_new_price,
    v_new_winner,
    a.end_time;
end;
$$;

-- ── Table grants ──────────────────────────────────────────────────────────────
-- anon + authenticated: read-only; place_bid is the sole write path for bids.
-- service_role: full access (Vitest test client connects as service_role).

grant select on dealers     to anon, authenticated;
grant select on vehicles    to anon, authenticated;
grant select on auctions    to anon, authenticated;
grant select on bids        to anon, authenticated;
grant select on settlements to anon, authenticated;

grant execute on function place_bid(uuid, uuid, int) to anon, authenticated;

grant select, insert, update, delete on dealers     to service_role;
grant select, insert, update, delete on vehicles    to service_role;
grant select, insert, update, delete on auctions    to service_role;
grant select, insert, update, delete on bids        to service_role;
grant select, insert, update, delete on settlements to service_role;

-- ── Realtime publication ──────────────────────────────────────────────────────

alter publication supabase_realtime add table auctions;
alter publication supabase_realtime add table bids;
