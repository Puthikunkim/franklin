create or replace function close_auction(p_auction_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  a auctions%rowtype;
begin
  select * into a from auctions where id = p_auction_id for update;
  if a.status <> 'live' then return a.status; end if;
  if a.end_time > now() then return 'live'; end if;
  if a.current_bid is not null and a.current_bid >= a.reserve_price then
    update auctions set status = 'sold' where id = p_auction_id;
    insert into settlements (auction_id, sale_price)
      values (p_auction_id, a.current_bid)
      on conflict (auction_id) do nothing;
    return 'sold';
  else
    update auctions set status = 'passed' where id = p_auction_id;
    return 'passed';
  end if;
end;
$$;

grant execute on function close_auction(uuid) to anon, authenticated;
