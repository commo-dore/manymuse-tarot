create table if not exists persona_settings (
  id int primary key default 1 check (id = 1),
  instructions text not null default '',
  updated_at timestamptz not null default now()
);
insert into persona_settings (id) values (1) on conflict do nothing;

create table if not exists persona_tests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  customer_name text not null default 'Customer',
  message text not null,
  cards jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists persona_test_runs (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references persona_tests(id) on delete cascade,
  model text not null,
  persona_snapshot text not null default '',
  output text not null,
  created_at timestamptz not null default now()
);
alter table persona_settings enable row level security;
alter table persona_tests enable row level security;
alter table persona_test_runs enable row level security;

insert into persona_tests (name, customer_name, message, cards)
select * from (values
  ('Heartbreak — wants honesty', 'Brianna', 'My ex broke up with me 4 months ago and I still check his socials every day. He has a new girlfriend now. I keep dreaming about him. Is he coming back or do I need to move on? Please be honest, I can take it.', '["Clinging to the Past","Letting Go"]'::jsonb),
  ('Career leap', 'Marcus', 'I''ve been at my corporate job 9 years and I hate it. I have a side business doing custom woodwork that''s starting to make real money. My wife is scared about health insurance. Should I take the leap this year?', '["Stress","The Creator","Success"]'::jsonb),
  ('Lonely expat', 'Yuki', 'I just moved to a new country for my husband''s job. I don''t speak the language well and I feel invisible. I used to be the social one. Who am I here?', '["Aloneness"]'::jsonb),
  ('Gym crush', 'Deja', 'There''s a guy at my gym, we talk every time we see each other and he remembers little things I say. But he hasn''t asked me out. Am I imagining the connection? Should I make the first move?', '["Projections","Trust"]'::jsonb),
  ('Family duty vs dream', 'Tom', 'I''m the oldest son and my parents expect me to take over the family restaurant. My brother won''t help. I got into a nursing program which is my real dream. If I go, the restaurant probably closes. How do I choose without destroying the family?', '["The Burden","Compromise","Breakthrough"]'::jsonb)
) v(name, customer_name, message, cards)
where not exists (select 1 from persona_tests);
