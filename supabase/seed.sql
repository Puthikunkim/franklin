-- Seed data for wholesale vehicle auction demo
-- All money values in integer cents; statuses live/ended/sold/passed; grades A-E

-- ── Dealers ──────────────────────────────────────────────────────────────────
insert into dealers (id, business_name, dealer_license_no, region, rating, initials) values
  ('11111111-1111-1111-1111-111111111111','Auckland Motor Wholesale','MVT12345','Auckland',4.8,'AM'),
  ('22222222-2222-2222-2222-222222222222','Waikato Trade Cars','MVT23456','Hamilton',4.6,'WT'),
  ('33333333-3333-3333-3333-333333333333','Capital Auto Traders','MVT34567','Wellington',4.7,'CA'),
  ('44444444-4444-4444-4444-444444444444','Southern Vehicle Exchange','MVT45678','Christchurch',4.5,'SV'),
  ('55555555-5555-5555-5555-555555555555','BayCity Dealer Group','MVT56789','Tauranga',4.9,'BC');

-- ── Auction 1 (FIXED ID – Task 4 / Playwright anchor) ────────────────────────
-- id = a0000000-0000-0000-0000-000000000a01
-- starting_price=600000, reserve=750000, buy_now=950000, bid_increment=25000
-- end_time = now() + 2 hours (well outside anti-snipe window)
with v as (
  insert into vehicles (id, make, model, year, variant, odometer_km, grade, color, mechanical_notes, appraisal_notes, photo_urls)
  values ('aaaaaaa1-0000-0000-0000-000000000001','Toyota','Corolla',2019,'GX Hatch',68000,'B','Silver',
    'Minor front bumper scuff. Cambelt done at 60k.','Clean trade-in, tidy example.',
    array['https://media.example-r2.dev/corolla-1.jpg'])
  returning id
)
insert into auctions (id, vehicle_id, seller_dealer_id, end_time, starting_price, reserve_price, buy_now_price)
select 'a0000000-0000-0000-0000-000000000a01', v.id,
  '11111111-1111-1111-1111-111111111111',
  now() + interval '2 hours',
  600000, 750000, 950000
from v;

-- ── Auction 2 ─────────────────────────────────────────────────────────────────
with v as (
  insert into vehicles (id, make, model, year, variant, odometer_km, grade, color, mechanical_notes, appraisal_notes, photo_urls)
  values ('aaaaaaa2-0000-0000-0000-000000000002','Mazda','CX-5',2020,'Limited',52000,'A','Soul Red',
    'No issues found. Full service history.','Excellent condition, barely used.',
    array['https://media.example-r2.dev/cx5-1.jpg'])
  returning id
)
insert into auctions (id, vehicle_id, seller_dealer_id, end_time, starting_price, reserve_price, buy_now_price)
select 'a0000000-0000-0000-0000-000000000a02', v.id,
  '22222222-2222-2222-2222-222222222222',
  now() + interval '90 minutes',
  850000, 1000000, 1250000
from v;

-- ── Auction 3 ─────────────────────────────────────────────────────────────────
with v as (
  insert into vehicles (id, make, model, year, variant, odometer_km, grade, color, mechanical_notes, appraisal_notes, photo_urls)
  values ('aaaaaaa3-0000-0000-0000-000000000003','Honda','CR-V',2018,'VTi-L',89000,'B','Lunar Silver',
    'New tyres. AC serviced 6 months ago.','One owner, clean interior.',
    array['https://media.example-r2.dev/crv-1.jpg'])
  returning id
)
insert into auctions (id, vehicle_id, seller_dealer_id, end_time, starting_price, reserve_price, buy_now_price)
select 'a0000000-0000-0000-0000-000000000a03', v.id,
  '33333333-3333-3333-3333-333333333333',
  now() + interval '75 minutes',
  700000, 850000, 1100000
from v;

-- ── Auction 4 ─────────────────────────────────────────────────────────────────
with v as (
  insert into vehicles (id, make, model, year, variant, odometer_km, grade, color, mechanical_notes, appraisal_notes, photo_urls)
  values ('aaaaaaa4-0000-0000-0000-000000000004','Subaru','Forester',2021,'Premium',41000,'A','Crystal White',
    'Showroom condition. Under manufacturer warranty.','Demo vehicle, low kms.',
    array['https://media.example-r2.dev/forester-1.jpg'])
  returning id
)
insert into auctions (id, vehicle_id, seller_dealer_id, end_time, starting_price, reserve_price, buy_now_price)
select 'a0000000-0000-0000-0000-000000000a04', v.id,
  '44444444-4444-4444-4444-444444444444',
  now() + interval '60 minutes',
  1100000, 1300000, 1600000
from v;

-- ── Auction 5 ─────────────────────────────────────────────────────────────────
with v as (
  insert into vehicles (id, make, model, year, variant, odometer_km, grade, color, mechanical_notes, appraisal_notes, photo_urls)
  values ('aaaaaaa5-0000-0000-0000-000000000005','Nissan','Leaf',2022,'e+',29000,'A','Gun Metallic',
    'Full EV. Battery health 98%. Charging cable included.','Near-new, second owner.',
    array['https://media.example-r2.dev/leaf-1.jpg'])
  returning id
)
insert into auctions (id, vehicle_id, seller_dealer_id, end_time, starting_price, reserve_price, buy_now_price)
select 'a0000000-0000-0000-0000-000000000a05', v.id,
  '55555555-5555-5555-5555-555555555555',
  now() + interval '45 minutes',
  1400000, 1650000, 2000000
from v;

-- ── Auction 6 ─────────────────────────────────────────────────────────────────
with v as (
  insert into vehicles (id, make, model, year, variant, odometer_km, grade, color, mechanical_notes, appraisal_notes, photo_urls)
  values ('aaaaaaa6-0000-0000-0000-000000000006','Toyota','Hilux',2017,'SR Double Cab',118000,'C','White',
    'Tow bar fitted. Some body marks consistent with age.','Trade-in from fleet operator.',
    array['https://media.example-r2.dev/hilux-1.jpg'])
  returning id
)
insert into auctions (id, vehicle_id, seller_dealer_id, end_time, starting_price, reserve_price, buy_now_price)
select 'a0000000-0000-0000-0000-000000000a06', v.id,
  '11111111-1111-1111-1111-111111111111',
  now() + interval '30 minutes',
  550000, 680000, 900000
from v;

-- ── Auction 7 ─────────────────────────────────────────────────────────────────
with v as (
  insert into vehicles (id, make, model, year, variant, odometer_km, grade, color, mechanical_notes, appraisal_notes, photo_urls)
  values ('aaaaaaa7-0000-0000-0000-000000000007','Ford','Ranger',2019,'XLT 4x4',74000,'B','Magnetic Grey',
    'Towbar, canopy. Recent WOF.','Well maintained fleet vehicle.',
    array['https://media.example-r2.dev/ranger-1.jpg'])
  returning id
)
insert into auctions (id, vehicle_id, seller_dealer_id, end_time, starting_price, reserve_price, buy_now_price)
select 'a0000000-0000-0000-0000-000000000a07', v.id,
  '22222222-2222-2222-2222-222222222222',
  now() + interval '20 minutes',
  900000, 1050000, 1350000
from v;

-- ── Auction 8 ─────────────────────────────────────────────────────────────────
with v as (
  insert into vehicles (id, make, model, year, variant, odometer_km, grade, color, mechanical_notes, appraisal_notes, photo_urls)
  values ('aaaaaaa8-0000-0000-0000-000000000008','Mitsubishi','Outlander PHEV',2021,'Exceed',38000,'A','Ironbark Silver',
    'Plug-in hybrid. Charging cable included. No faults.','One owner, excellent upkeep.',
    array['https://media.example-r2.dev/outlander-1.jpg'])
  returning id
)
insert into auctions (id, vehicle_id, seller_dealer_id, end_time, starting_price, reserve_price, buy_now_price)
select 'a0000000-0000-0000-0000-000000000a08', v.id,
  '33333333-3333-3333-3333-333333333333',
  now() + interval '10 minutes',
  1200000, 1450000, 1800000
from v;

-- ── Auction 9 ─────────────────────────────────────────────────────────────────
with v as (
  insert into vehicles (id, make, model, year, variant, odometer_km, grade, color, mechanical_notes, appraisal_notes, photo_urls)
  values ('aaaaaaa9-0000-0000-0000-000000000009','Volkswagen','Golf',2020,'GTI',56000,'B','Deep Black Pearl',
    'Stage 1 tune. Recent brake service.','Enthusiast-owned, clean history.',
    array['https://media.example-r2.dev/golf-1.jpg'])
  returning id
)
insert into auctions (id, vehicle_id, seller_dealer_id, end_time, starting_price, reserve_price, buy_now_price)
select 'a0000000-0000-0000-0000-000000000a09', v.id,
  '44444444-4444-4444-4444-444444444444',
  now() + interval '5 minutes',
  780000, 920000, 1150000
from v;
