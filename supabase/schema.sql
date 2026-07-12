-- ManyMuse Tarot — run in Supabase SQL editor
create extension if not exists pgcrypto;

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  etsy_username text not null unique,
  display_name text,
  notes text default '',
  created_at timestamptz not null default now()
);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  order_ref text,
  customer_message text not null,
  card_name text,
  status text not null default 'new', -- new | draft | approved | sent
  placed_at timestamptz not null default now(),
  approved_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists readings (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  version int not null,
  content text not null,
  operator_comments text default '',
  created_at timestamptz not null default now()
);

create index if not exists readings_order_idx on readings(order_id, version desc);
create index if not exists orders_status_idx on orders(status, placed_at desc);

-- Service-role access only from the app server; lock down anon access.
alter table customers enable row level security;
alter table orders enable row level security;
alter table readings enable row level security;
