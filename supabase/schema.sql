-- 給他排下去 — Supabase 資料庫結構
-- 使用方式:在 Supabase 專案的 SQL Editor 貼上整份執行一次即可。

-- 家庭群組
create table if not exists groups (
  id uuid primary key default gen_random_uuid(),
  invite_code text unique not null,
  name text not null default '我的家庭',
  created_at timestamptz default now()
);

-- 群組成員
create table if not exists members (
  group_id uuid references groups(id) on delete cascade,
  user_id uuid not null,
  name text not null default '家人',
  joined_at timestamptz default now(),
  primary key (group_id, user_id)
);

-- 行事曆
create table if not exists calendars (
  id text primary key,
  group_id uuid references groups(id) on delete cascade,
  name text not null,
  color text not null,
  deleted boolean default false,
  updated_at_ms bigint not null
);

-- 行程
create table if not exists events (
  id text primary key,
  group_id uuid references groups(id) on delete cascade,
  calendar_id text not null,
  title text not null,
  all_day boolean default false,
  start_at timestamptz not null,
  end_at timestamptz not null,
  repeat text default 'none',
  reminder int,
  notes text default '',
  photo_urls jsonb default '[]',
  photo_ids jsonb default '[]',
  deleted boolean default false,
  updated_at_ms bigint not null
);

create index if not exists idx_events_group on events(group_id);
create index if not exists idx_calendars_group on calendars(group_id);

-- 開啟 Row Level Security
alter table groups enable row level security;
alter table members enable row level security;
alter table calendars enable row level security;
alter table events enable row level security;

-- 政策:登入者(含匿名登入)可建立/查詢群組(靠邀請碼加入)
create policy "anyone can create group" on groups for insert to authenticated with check (true);
create policy "anyone can read group by code" on groups for select to authenticated using (true);

create policy "join group" on members for insert to authenticated with check (user_id = auth.uid());
create policy "read own memberships" on members for select to authenticated using (true);
create policy "update own membership" on members for update to authenticated using (user_id = auth.uid());

-- 只有群組成員能讀寫該群組的行事曆與行程
create policy "members read calendars" on calendars for select to authenticated
  using (group_id in (select group_id from members where user_id = auth.uid()));
create policy "members write calendars" on calendars for insert to authenticated
  with check (group_id in (select group_id from members where user_id = auth.uid()));
create policy "members update calendars" on calendars for update to authenticated
  using (group_id in (select group_id from members where user_id = auth.uid()));

create policy "members read events" on events for select to authenticated
  using (group_id in (select group_id from members where user_id = auth.uid()));
create policy "members write events" on events for insert to authenticated
  with check (group_id in (select group_id from members where user_id = auth.uid()));
create policy "members update events" on events for update to authenticated
  using (group_id in (select group_id from members where user_id = auth.uid()));

-- 開啟即時同步
alter publication supabase_realtime add table events;
alter publication supabase_realtime add table calendars;

-- 照片儲存桶(公開讀取,成員上傳)
insert into storage.buckets (id, name, public) values ('photos', 'photos', true)
on conflict (id) do nothing;

create policy "members upload photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos');
create policy "public read photos" on storage.objects for select
  using (bucket_id = 'photos');
create policy "members update photos" on storage.objects for update to authenticated
  using (bucket_id = 'photos');
