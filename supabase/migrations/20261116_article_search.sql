begin;

alter table public.articles
  add column if not exists fts tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(article_number, '') || ' ' || coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(chapter, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'C')
  ) stored;

create index if not exists articles_fts_idx
  on public.articles using gin (fts);

create or replace function public.search_articles(
  query text,
  country_ids text[] default null,
  k integer default 8
)
returns table (
  id text,
  constitution_id text,
  chapter text,
  article_number text,
  title text,
  content text,
  ord integer,
  source text,
  rank real,
  matched_all boolean
)
language sql
stable
security invoker
set search_path = public
as $$
  with q as (
    select websearch_to_tsquery('english', query) as all_terms,
           nullif(replace(websearch_to_tsquery('english', query)::text, ' & ', ' | '), '')::tsquery as any_term,
           least(greatest(k, 1), 50) as lim
  ),
  exact as (
    select a.id, a.constitution_id, a.chapter, a.article_number, a.title, a.content, a.ord, a.source,
           ts_rank_cd(a.fts, q.any_term, 33) as rank, true as matched_all
      from public.articles a, q
     where a.active
       and q.any_term is not null
       and a.fts @@ q.all_terms
       and (country_ids is null or cardinality(country_ids) = 0 or a.constitution_id = any(country_ids))
     order by rank desc
     limit (select lim from q)
  ),
  loose as (
    select a.id, a.constitution_id, a.chapter, a.article_number, a.title, a.content, a.ord, a.source,
           ts_rank_cd(a.fts, q.any_term, 33) as rank, false as matched_all
      from public.articles a, q
     where a.active
       and q.any_term is not null
       and a.fts @@ q.any_term
       and not a.fts @@ q.all_terms
       and (country_ids is null or cardinality(country_ids) = 0 or a.constitution_id = any(country_ids))
     order by rank desc
     limit (select lim from q) - (select count(*) from exact)
  )
  select * from exact
  union all
  select * from loose
  order by matched_all desc, rank desc;
$$;

grant execute on function public.search_articles(text, text[], integer) to anon, authenticated;

commit;
