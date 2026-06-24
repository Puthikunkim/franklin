-- Slice 2: listing creation. Draft status + nullable start_time + writer RPCs.
alter type auction_status add value if not exists 'draft';
alter table auctions alter column start_time drop not null;

-- Create a draft listing (vehicle + draft auction) atomically. Returns auction id.
create or replace function create_draft_listing(
  p_dealer_id uuid, p_make text, p_model text, p_year int, p_variant text,
  p_odometer_km int, p_grade vehicle_grade, p_color text,
  p_mechanical_notes text, p_appraisal_notes text, p_photo_urls text[],
  p_starting_price int, p_reserve_price int, p_buy_now_price int, p_end_time timestamptz
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_vehicle uuid; v_auction uuid;
begin
  insert into vehicles (make, model, year, variant, odometer_km, grade, color,
    mechanical_notes, appraisal_notes, photo_urls)
  values (p_make, p_model, p_year, p_variant, p_odometer_km, p_grade, p_color,
    p_mechanical_notes, p_appraisal_notes, coalesce(p_photo_urls, '{}'))
  returning id into v_vehicle;

  insert into auctions (vehicle_id, seller_dealer_id, start_time, end_time, status,
    starting_price, reserve_price, buy_now_price)
  values (v_vehicle, p_dealer_id, null, p_end_time, 'draft',
    p_starting_price, p_reserve_price, p_buy_now_price)
  returning id into v_auction;

  return v_auction;
end; $$;

-- Update a draft (vehicle + auction) only if owned by the dealer and still a draft.
create or replace function update_draft_listing(
  p_auction_id uuid, p_dealer_id uuid, p_make text, p_model text, p_year int, p_variant text,
  p_odometer_km int, p_grade vehicle_grade, p_color text,
  p_mechanical_notes text, p_appraisal_notes text, p_photo_urls text[],
  p_starting_price int, p_reserve_price int, p_buy_now_price int, p_end_time timestamptz
) returns text language plpgsql security definer set search_path = public as $$
declare a auctions%rowtype;
begin
  select * into a from auctions where id = p_auction_id for update;
  if not found or a.seller_dealer_id <> p_dealer_id then return 'not_owner'; end if;
  if a.status <> 'draft' then return 'not_draft'; end if;

  update vehicles set make = p_make, model = p_model, year = p_year, variant = p_variant,
    odometer_km = p_odometer_km, grade = p_grade, color = p_color,
    mechanical_notes = p_mechanical_notes, appraisal_notes = p_appraisal_notes,
    photo_urls = coalesce(p_photo_urls, '{}')
  where id = a.vehicle_id;

  update auctions set starting_price = p_starting_price, reserve_price = p_reserve_price,
    buy_now_price = p_buy_now_price, end_time = p_end_time
  where id = p_auction_id;

  return 'updated';
end; $$;

-- Publish a draft: guard ownership/status, re-validate, flip live with start_time=now().
create or replace function publish_listing(p_auction_id uuid, p_dealer_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare a auctions%rowtype; v_photos int;
begin
  select * into a from auctions where id = p_auction_id for update;
  if not found or a.seller_dealer_id <> p_dealer_id then return 'not_owner'; end if;
  if a.status <> 'draft' then return 'not_draft'; end if;
  if a.end_time <= now() then return 'end_in_past'; end if;
  select coalesce(array_length(photo_urls, 1), 0) into v_photos from vehicles where id = a.vehicle_id;
  if v_photos < 1 then return 'no_photos'; end if;

  update auctions set status = 'live', start_time = now() where id = p_auction_id;
  return 'live';
end; $$;

-- Writers are service-role only: the browser anon key must never reach these.
grant execute on function create_draft_listing(uuid, text, text, int, text, int, vehicle_grade, text, text, text, text[], int, int, int, timestamptz) to service_role;
grant execute on function update_draft_listing(uuid, uuid, text, text, int, text, int, vehicle_grade, text, text, text, text[], int, int, int, timestamptz) to service_role;
grant execute on function publish_listing(uuid, uuid) to service_role;
