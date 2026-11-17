begin;

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
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  all_terms tsquery := websearch_to_tsquery('english', query);
  any_term tsquery := nullif(replace(all_terms::text, ' & ', ' | '), '')::tsquery;
  lim integer := least(greatest(k, 1), 50);
  exact_rows integer;
begin
  if any_term is null then
    return;
  end if;

  if cardinality(country_ids) > 0 then
    return query
      with pool as materialized (
        select a.id, a.constitution_id, a.chapter, a.article_number, a.title, a.content, a.ord, a.source, a.fts
          from public.articles a
         where a.active
           and a.constitution_id = any(country_ids)
      )
      select p.id, p.constitution_id, p.chapter, p.article_number, p.title, p.content, p.ord, p.source,
             ts_rank_cd(p.fts, any_term, 33), p.fts @@ all_terms
        from pool p
       where p.fts @@ any_term
       order by 10 desc, 9 desc
       limit lim;
    return;
  end if;

  return query
    select a.id, a.constitution_id, a.chapter, a.article_number, a.title, a.content, a.ord, a.source,
           ts_rank_cd(a.fts, any_term, 33), true
      from public.articles a
     where a.active
       and a.fts @@ all_terms
     order by 9 desc
     limit lim;
  get diagnostics exact_rows = row_count;

  if exact_rows < lim then
    return query
      select a.id, a.constitution_id, a.chapter, a.article_number, a.title, a.content, a.ord, a.source,
             ts_rank_cd(a.fts, any_term, 33), false
        from public.articles a
       where a.active
         and a.fts @@ any_term
         and not a.fts @@ all_terms
       order by 9 desc
       limit lim - exact_rows;
  end if;
end;
$$;

grant execute on function public.search_articles(text, text[], integer) to anon, authenticated;

commit;
