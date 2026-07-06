-- Slice 10: seller withdraws a live auction that already has bids. Unlike Slice 6's unpublish
-- (no bids → revert to draft), a bid-on auction goes to a new terminal 'cancelled' status and
-- every distinct bidder is notified. Adding the enum value and using it in the (late-bound)
-- function body in one migration is safe — same pattern 0004 used for 'draft'.

alter type auction_status add value if not exists 'cancelled';

-- Allow the new bidder-facing notification type.
alter table notifications drop constraint if exists notifications_type_check;
alter table notifications add constraint notifications_type_check
  check (type in ('outbid','won','sold','withdrawn'));

create or replace function withdraw_listing(p_auction_id uuid, p_dealer_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare a auctions%rowtype; r record;
begin
  select * into a from auctions where id = p_auction_id for update;
  if not found or a.seller_dealer_id <> p_dealer_id then return 'not_owner'; end if;
  if a.status <> 'live' then return 'not_live'; end if;
  if a.current_bid is null then return 'no_bids'; end if;   -- no bids → use unpublish (revert to draft)
  update auctions set status = 'cancelled' where id = p_auction_id;
  for r in select distinct bidder_dealer_id from bids where auction_id = p_auction_id loop
    perform _notify(r.bidder_dealer_id, 'withdrawn', p_auction_id);
  end loop;
  return 'withdrawn';
end; $$;

-- Writer is service-role only: revoke the PUBLIC default first (Slice 2-9 pattern).
revoke execute on function withdraw_listing(uuid, uuid) from public, anon, authenticated;
grant execute on function withdraw_listing(uuid, uuid) to service_role;
