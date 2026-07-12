alter table orders add column if not exists cards jsonb not null default '[]'::jsonb;
alter table orders add column if not exists source text not null default 'manual';
alter table orders add column if not exists etsy_receipt_id text unique;
alter table orders add column if not exists etsy_buyer_username text;
create table if not exists etsy_tokens (
  id int primary key default 1 check (id = 1),
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table etsy_tokens enable row level security;
-- backfill existing single-card orders
update orders set cards = to_jsonb(array[card_name]) where card_name is not null and cards = '[]'::jsonb;
