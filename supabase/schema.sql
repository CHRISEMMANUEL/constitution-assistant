create table if not exists public.constitutions (
  id            text primary key,
  country       text not null,
  country_code  text,
  flag          text,
  region        text not null check (region in (
    'africa','asia','europe','americas','oceania','arctic','mideast'
  )),
  title         text not null,
  adopted       text,
  summary       text,
  created_at    timestamptz not null default now()
);

alter table public.constitutions
  add column if not exists capital         text,
  add column if not exists population      bigint,
  add column if not exists languages       text[],
  add column if not exists subregion       text,
  add column if not exists flag_image_url  text;

alter table public.constitutions
  add column if not exists source_name           text,
  add column if not exists source_url            text,
  add column if not exists license               text,
  add column if not exists language              text,
  add column if not exists official_translation  boolean,
  add column if not exists retrieved_at          timestamptz;

create table if not exists public.articles (
  id                text primary key,
  constitution_id   text not null references public.constitutions(id) on delete cascade,
  chapter           text,
  article_number    text not null,
  title             text not null,
  content           text not null,
  ord               integer,
  created_at        timestamptz not null default now()
);

create index if not exists articles_constitution_idx
  on public.articles (constitution_id);

create index if not exists articles_constitution_ord_idx
  on public.articles (constitution_id, ord);

alter table public.articles
  add column if not exists source  text not null default 'manual',
  add column if not exists active  boolean not null default true;

create index if not exists articles_constitution_active_ord_idx
  on public.articles (constitution_id, active, ord);

create table if not exists public.bookmarks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  article_id  text not null references public.articles(id) on delete restrict,
  note        text,
  created_at  timestamptz not null default now(),
  unique (user_id, article_id)
);

alter table public.constitutions enable row level security;
alter table public.articles      enable row level security;
alter table public.bookmarks     enable row level security;

drop policy if exists "constitutions are readable by anyone" on public.constitutions;
create policy "constitutions are readable by anyone"
  on public.constitutions for select
  using (true);

drop policy if exists "articles are readable by anyone" on public.articles;
create policy "articles are readable by anyone"
  on public.articles for select
  using (true);

drop policy if exists "users can read their own bookmarks" on public.bookmarks;
create policy "users can read their own bookmarks"
  on public.bookmarks for select
  using (auth.uid() = user_id);

drop policy if exists "users can insert their own bookmarks" on public.bookmarks;
create policy "users can insert their own bookmarks"
  on public.bookmarks for insert
  with check (auth.uid() = user_id);

drop policy if exists "users can delete their own bookmarks" on public.bookmarks;
create policy "users can delete their own bookmarks"
  on public.bookmarks for delete
  using (auth.uid() = user_id);

drop policy if exists "users can update their own bookmarks" on public.bookmarks;
create policy "users can update their own bookmarks"
  on public.bookmarks for update
  using (auth.uid() = user_id);
