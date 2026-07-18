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

-- ── Readers (blind-safe, derive on read). security definer so they can read the
-- ── service-role-only ratings table; granted to anon/authenticated for page use. ──

-- Per-dealer seller/buyer averages over VISIBLE ratings; one row per requested id.
create or replace function get_dealers_reputation(p_dealer_ids uuid[])
returns table (dealer_id uuid, seller_avg numeric, seller_count int, buyer_avg numeric, buyer_count int)
language sql security definer set search_path = public as $$
  with visible as (
    select r.*
    from ratings r
    join settlements s on s.auction_id = r.auction_id
    where (select count(*) from ratings r2 where r2.auction_id = r.auction_id) = 2
       or s.created_at + interval '14 days' <= now()
  )
  select d.id,
    round(avg(v.score) filter (where v.direction = 'seller'), 1),
    count(*) filter (where v.direction = 'seller')::int,
    round(avg(v.score) filter (where v.direction = 'buyer'), 1),
    count(*) filter (where v.direction = 'buyer')::int
  from unnest(p_dealer_ids) as d(id)
  left join visible v on v.ratee_dealer_id = d.id
  group by d.id;
$$;

-- Visible reviews about a dealer, newest first.
create or replace function get_dealer_reviews(p_dealer_id uuid)
returns table (direction text, score int, comment text, created_at timestamptz)
language sql security definer set search_path = public as $$
  select r.direction, r.score, r.comment, r.created_at
  from ratings r
  join settlements s on s.auction_id = r.auction_id
  where r.ratee_dealer_id = p_dealer_id
    and ((select count(*) from ratings r2 where r2.auction_id = r.auction_id) = 2
         or s.created_at + interval '14 days' <= now())
  order by r.created_at desc;
$$;

-- Everything the rate panel needs for one viewer on one auction.
create or replace function get_rating_state(p_auction_id uuid, p_viewer_dealer_id uuid)
returns table (
  eligible boolean, window_open boolean, already_rated boolean,
  counterpart_submitted boolean, revealed boolean,
  my_score int, my_comment text, counterpart_score int, counterpart_comment text
) language plpgsql security definer set search_path = public as $$
declare
  a auctions%rowtype; s settlements%rowtype;
  v_mine ratings%rowtype; v_theirs ratings%rowtype;
  v_count int; v_revealed boolean;
begin
  select * into a from auctions where id = p_auction_id;
  if not found or a.status <> 'sold' or a.seller_dealer_id = a.current_winner_dealer_id
     or p_viewer_dealer_id not in (a.seller_dealer_id, a.current_winner_dealer_id) then
    return query select false, false, false, false, false,
      null::int, null::text, null::int, null::text;
    return;
  end if;

  select * into s from settlements where auction_id = p_auction_id;
  select count(*) into v_count from ratings where auction_id = p_auction_id;
  select * into v_mine from ratings
    where auction_id = p_auction_id and rater_dealer_id = p_viewer_dealer_id;
  select * into v_theirs from ratings
    where auction_id = p_auction_id and rater_dealer_id <> p_viewer_dealer_id limit 1;
  v_revealed := (v_count = 2) or (s.created_at + interval '14 days' <= now());

  return query select
    true,
    (s.created_at + interval '14 days' > now()),
    (v_mine.id is not null),
    (v_theirs.id is not null),
    v_revealed,
    v_mine.score, v_mine.comment,
    case when v_revealed then v_theirs.score else null end,
    case when v_revealed then v_theirs.comment else null end;
end; $$;

grant execute on function get_dealers_reputation(uuid[]) to anon, authenticated, service_role;
grant execute on function get_dealer_reviews(uuid) to anon, authenticated, service_role;
grant execute on function get_rating_state(uuid, uuid) to anon, authenticated, service_role;

-- The static per-dealer rating is replaced by derived reputation; remove it.
alter table dealers drop column rating;
