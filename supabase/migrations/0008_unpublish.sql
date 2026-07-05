-- Slice 6: seller unpublish. Revert a live, un-bid auction (owned by the dealer)
-- back to a draft, so the seller can edit and republish via the existing draft flow.
create or replace function unpublish_listing(p_auction_id uuid, p_dealer_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare a auctions%rowtype;
begin
  select * into a from auctions where id = p_auction_id for update;
  if not found or a.seller_dealer_id <> p_dealer_id then return 'not_owner'; end if;
  if a.status <> 'live' then return 'not_live'; end if;          -- only a live auction can be unpublished
  if a.current_bid is not null then return 'has_bids'; end if;   -- never pull a listing out from under bidders
  update auctions set status = 'draft', start_time = null where id = p_auction_id;
  return 'reverted';
end; $$;

-- Writer is service-role only: revoke the PostgreSQL default PUBLIC grant that
-- anon/authenticated inherit, then grant to service_role (Slice 2–5 pattern).
revoke execute on function unpublish_listing(uuid, uuid) from public, anon, authenticated;
grant execute on function unpublish_listing(uuid, uuid) to service_role;
