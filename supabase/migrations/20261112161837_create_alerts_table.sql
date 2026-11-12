create table public.alerts (
  id              bigint generated always as identity primary key,
  notification_id text not null unique,
  universe_id     text not null,
  metric          text not null,
  status          text not null check (status in ('fired', 'recovered')),
  summary         text not null,
  current_value   text,
  evaluated_at    timestamptz not null,
  received_at     timestamptz not null default now(),
  raw             jsonb not null
);

alter table public.alerts enable row level security;

create index alerts_universe_time_idx
  on public.alerts (universe_id, evaluated_at desc);
