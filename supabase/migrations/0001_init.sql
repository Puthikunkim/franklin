create type auction_status as enum ('live', 'ended', 'sold', 'passed');
create type vehicle_grade as enum ('A', 'B', 'C', 'D', 'E');

create table dealers (
  id uuid primary key default gen_random_uuid(),
  business_name text not null,
  dealer_license_no text not null,
  region text not null,
  rating numeric(2,1) not null default 4.5,
  is_verified boolean not null default true,
  initials text not null
);

create table vehicles (
  id uuid primary key default gen_random_uuid(),
  make text not null,
  model text not null,
  year int not null,
  variant text,
  odometer_km int not null,
  rego text,
  vin text,
  grade vehicle_grade not null,
  color text,
  mechanical_notes text,
  appraisal_notes text,
  photo_urls text[] not null default '{}'
);

create table auctions (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id),
  seller_dealer_id uuid not null references dealers(id),
  start_time timestamptz not null default now(),
  end_time timestamptz not null,
  starting_price int not null,         -- cents
  reserve_price int not null,          -- cents
  buy_now_price int,                   -- cents, nullable
  bid_increment int not null default 25000,
  anti_snipe_seconds int not null default 30,
  status auction_status not null default 'live',
  current_bid int,                     -- cents, nullable until first bid
  current_winner_dealer_id uuid references dealers(id)
);

create table bids (
  id uuid primary key default gen_random_uuid(),
  auction_id uuid not null references auctions(id),
  bidder_dealer_id uuid not null references dealers(id),
  amount int not null,                 -- cents
  max_amount int,                      -- cents, nullable (proxy ceiling)
  is_auto boolean not null default false,
  created_at timestamptz not null default now()
);

create table settlements (
  id uuid primary key default gen_random_uuid(),
  auction_id uuid not null unique references auctions(id),
  sale_price int not null,             -- cents
  seller_fee int not null default 20000,
  buyer_fee int not null default 2000,
  status text not null default 'arranged'
);

create index on bids (auction_id, created_at desc);
create index on auctions (status, end_time);
