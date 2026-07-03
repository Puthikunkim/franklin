-- Slice 3: discard (delete) a draft listing. Owner-gated, drafts only.
create or replace function discard_draft_listing(p_auction_id uuid, p_dealer_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare a auctions%rowtype;
begin
  select * into a from auctions where id = p_auction_id for update;
  if not found or a.seller_dealer_id <> p_dealer_id then return 'not_owner'; end if;
  if a.status <> 'draft' then return 'not_draft'; end if;
  delete from auctions where id = p_auction_id;      -- remove FK first
  delete from vehicles where id = a.vehicle_id;       -- draft's vehicle is unshared
  return 'discarded';
end; $$;

-- Writer is service-role only: revoke the PostgreSQL default PUBLIC grant that
-- anon/authenticated inherit, then grant to service_role.
revoke execute on function discard_draft_listing(uuid, uuid) from public, anon, authenticated;
grant execute on function discard_draft_listing(uuid, uuid) to service_role;
