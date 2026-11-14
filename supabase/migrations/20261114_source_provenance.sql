begin;

alter table public.constitutions
  add column if not exists source_name           text,
  add column if not exists source_url            text,
  add column if not exists license               text,
  add column if not exists language              text,
  add column if not exists official_translation  boolean,
  add column if not exists retrieved_at          timestamptz;

alter table public.articles
  add column if not exists source  text not null default 'manual',
  add column if not exists active  boolean not null default true;

create index if not exists articles_constitution_active_ord_idx
  on public.articles (constitution_id, active, ord);

update public.articles set source = 'constitute' where id like '%-cp-%' and source = 'manual';
update public.articles set source = 'wikipedia'  where id like '%-overview' and source = 'manual';
update public.articles set source = 'generated'  where id like '%-profile' and source = 'manual';

update public.articles a
   set active = false
 where a.source <> 'constitute'
   and a.active
   and exists (
     select 1 from public.articles c
      where c.constitution_id = a.constitution_id
        and c.source = 'constitute'
   );

update public.articles a
   set active = false
 where a.source = 'generated'
   and a.active
   and exists (
     select 1 from public.articles w
      where w.constitution_id = a.constitution_id
        and w.source = 'wikipedia'
   );

update public.constitutions c
   set source_name = 'Constitute Project',
       source_url  = 'https://www.constituteproject.org',
       license     = 'CC BY-NC 3.0',
       language    = 'en',
       official_translation = false
 where c.source_name is null
   and exists (select 1 from public.articles a
                where a.constitution_id = c.id and a.source = 'constitute' and a.active);

update public.constitutions c
   set source_name = 'Wikipedia',
       source_url  = 'https://en.wikipedia.org',
       license     = 'CC BY-SA 4.0',
       language    = 'en'
 where c.source_name is null
   and exists (select 1 from public.articles a
                where a.constitution_id = c.id and a.source = 'wikipedia' and a.active);

do $$
declare
  fk record;
begin
  for fk in
    select con.conname
      from pg_constraint con
      join pg_attribute att
        on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
     where con.conrelid = 'public.bookmarks'::regclass
       and con.contype = 'f'
       and att.attname = 'article_id'
  loop
    execute format('alter table public.bookmarks drop constraint %I', fk.conname);
  end loop;
end $$;

alter table public.bookmarks
  add constraint bookmarks_article_id_fkey
  foreign key (article_id) references public.articles(id) on delete restrict;

commit;
