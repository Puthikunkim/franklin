-- Slice 12: trade rating / reputation. Bidirectional, blind-reveal ratings left after a sale.
-- The ratings rows are the single source of truth; visibility and averages are derived on read.
-- This migration is built up across the ratings tasks; run `npx supabase db reset` after each edit.

create table ratings (
  id              uuid primary key default gen_random_uuid(),
  auction_id      uuid not null references auctions(id),
  rater_dealer_id uuid not null references dealers(id),
  ratee_dealer_id uuid not null references dealers(id),
  direction       text not null check (direction in ('seller','buyer')),
  score           int  not null check (score between 1 and 5),
  comment         text check (comment is null or char_length(comment) <= 280),
  created_at      timestamptz not null default now(),
  unique (auction_id, rater_dealer_id)
);
create index on ratings (ratee_dealer_id, direction);

-- Anchor for the 14-day window: the settlement is inserted exactly at sale time.
alter table settlements add column created_at timestamptz not null default now();

-- ── Writer: submit one rating. service_role only; identity comes from the server cookie. ──
create or replace function submit_rating(
  p_auction_id uuid, p_rater_dealer_id uuid, p_score int, p_comment text
) returns text language plpgsql security definer set search_path = public as $$
declare
  a auctions%rowtype;
  s settlements%rowtype;
  v_ratee uuid;
  v_direction text;
begin
  if p_score < 1 or p_score > 5 then return 'bad_score'; end if;

  select * into a from auctions where id = p_auction_id;
  if not found or a.status <> 'sold' then return 'not_sold'; end if;
  if a.seller_dealer_id = a.current_winner_dealer_id then return 'not_party'; end if;

  if p_rater_dealer_id = a.seller_dealer_id then
    v_ratee := a.current_winner_dealer_id; v_direction := 'buyer';
  elsif p_rater_dealer_id = a.current_winner_dealer_id then
    v_ratee := a.seller_dealer_id; v_direction := 'seller';
  else
    return 'not_party';
  end if;

  select * into s from settlements where auction_id = p_auction_id;
  if not found then return 'not_sold'; end if;
  if s.created_at + interval '14 days' <= now() then return 'window_closed'; end if;

  if exists (select 1 from ratings where auction_id = p_auction_id and rater_dealer_id = p_rater_dealer_id) then
    return 'already_rated';
  end if;

  insert into ratings (auction_id, rater_dealer_id, ratee_dealer_id, direction, score, comment)
    values (p_auction_id, p_rater_dealer_id, v_ratee, v_direction, p_score,
            nullif(btrim(coalesce(p_comment, '')), ''));
  return 'ok';
end; $$;

revoke execute on function submit_rating(uuid, uuid, int, text) from public, anon, authenticated;
grant execute on function submit_rating(uuid, uuid, int, text) to service_role;

-- ratings table: service_role only (blind-safety — reads go through reader functions).
grant select, insert, update, delete on ratings to service_role;

-- ── Test helper: backdate a settlement to exercise the window-elapsed path. ──
create or replace function test_set_settlement_age(p_auction_id uuid, p_seconds int)
returns void language sql security definer set search_path = public as $$
  update settlements set created_at = now() - make_interval(secs => p_seconds)
  where auction_id = p_auction_id;
$$;

-- Extend test_reset (last defined in 0009) to also clear ratings between tests.
create or replace function test_reset() returns void language plpgsql security definer as $$
begin
  truncate ratings restart identity cascade;
  truncate bids restart identity cascade;
  truncate settlements restart identity cascade;
  truncate notifications restart identity cascade;
  update auctions
    set current_bid = null,
        current_winner_dealer_id = null,
        status = 'live',
        end_time = now() + interval '2 hours'
  where status <> 'draft';
end;
$$;

-- ── 'rate' notification type + emit it at settlement from both writers ──
alter table notifications drop constraint if exists notifications_type_check;
alter table notifications add constraint notifications_type_check
  check (type in ('outbid','won','sold','withdrawn','rate'));

-- close_auction: keep the 0009 body; add a 'rate' prompt to winner and seller on a sale.
create or replace function close_auction(p_auction_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare a auctions%rowtype;
begin
  select * into a from auctions where id = p_auction_id for update;
  if a.status <> 'live' then return a.status; end if;
  if a.end_time > now() then return 'live'; end if;
  if a.current_bid is not null and a.current_bid >= a.reserve_price then
    update auctions set status = 'sold' where id = p_auction_id;
    insert into settlements (auction_id, sale_price)
      values (p_auction_id, a.current_bid)
      on conflict (auction_id) do nothing;
    perform _notify(a.current_winner_dealer_id, 'won', p_auction_id);
    perform _notify(a.seller_dealer_id, 'sold', p_auction_id);
    perform _notify(a.current_winner_dealer_id, 'rate', p_auction_id);
    perform _notify(a.seller_dealer_id, 'rate', p_auction_id);
    return 'sold';
  else
    update auctions set status = 'passed' where id = p_auction_id;
    return 'passed';
  end if;
end; $$;

-- buy_now_listing: keep the 0009 body; add a 'rate' prompt to buyer and seller.
create or replace function buy_now_listing(p_auction_id uuid, p_buyer_dealer_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare a auctions%rowtype;
begin
  select * into a from auctions where id = p_auction_id for update;
  if not found then return 'not_found'; end if;
  if a.status <> 'live' then return a.status; end if;
  if a.buy_now_price is null then return 'no_buy_now'; end if;
  if a.current_bid is not null then return 'has_bids'; end if;
  if a.seller_dealer_id = p_buyer_dealer_id then return 'is_seller'; end if;

  update auctions
     set status = 'sold',
         current_bid = a.buy_now_price,
         current_winner_dealer_id = p_buyer_dealer_id,
         end_time = now()
   where id = p_auction_id;

  insert into settlements (auction_id, sale_price)
     values (p_auction_id, a.buy_now_price)
     on conflict (auction_id) do nothing;
  perform _notify(a.seller_dealer_id, 'sold', p_auction_id);
  perform _notify(p_buyer_dealer_id, 'rate', p_auction_id);
  perform _notify(a.seller_dealer_id, 'rate', p_auction_id);
  return 'bought';
end; $$;
