-- Slice 5: buy-now. Purchase a live, un-bid auction outright at its buy_now_price.
-- Ends the auction as a sale to the buyer and creates the settlement, mirroring
-- close_auction. Buy-now is only allowed before the first bid.
create or replace function buy_now_listing(p_auction_id uuid, p_buyer_dealer_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare a auctions%rowtype;
begin
  select * into a from auctions where id = p_auction_id for update;
  if not found then return 'not_found'; end if;
  if a.status <> 'live' then return a.status; end if;          -- already sold/ended/draft/passed
  if a.buy_now_price is null then return 'no_buy_now'; end if;
  if a.current_bid is not null then return 'has_bids'; end if; -- buy-now only before the first bid
  if a.seller_dealer_id = p_buyer_dealer_id then return 'is_seller'; end if;

  update auctions
     set status = 'sold',
         current_bid = a.buy_now_price,          -- sale price (mirrors close_auction using current_bid)
         current_winner_dealer_id = p_buyer_dealer_id,
         end_time = now()                        -- genuinely ended, so My wins / My sales pick it up
   where id = p_auction_id;

  insert into settlements (auction_id, sale_price)
     values (p_auction_id, a.buy_now_price)
     on conflict (auction_id) do nothing;        -- never resell / double-settle
  return 'bought';   -- distinct from the 'sold' STATUS: only a fresh purchase returns this
end; $$;

-- Writer is service-role only: revoke the PostgreSQL default PUBLIC grant that
-- anon/authenticated inherit, then grant to service_role (Slice 2–4 pattern).
revoke execute on function buy_now_listing(uuid, uuid) from public, anon, authenticated;
grant execute on function buy_now_listing(uuid, uuid) to service_role;
