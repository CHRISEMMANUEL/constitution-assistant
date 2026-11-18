import { supabase } from '../lib/supabase';
import {
  constitutions as bundledConstitutions,
  articles as bundledArticles,
  type BundledArticle,
  type BundledConstitution,
  type Region,
} from '../data/constitutions';

export interface Constitution extends BundledConstitution {
  indexed?: boolean;
  flag_image_url?: string;
  capital?: string;
  population?: number;
  languages?: string[];
  subregion?: string;
  source_name?: string | null;
  source_url?: string | null;
  license?: string | null;
  language?: string | null;
  official_translation?: boolean | null;
  retrieved_at?: string | null;
}
export type Article = BundledArticle;
export type { Region };

const isPlaceholderEnv = !import.meta.env.VITE_SUPABASE_URL;

const ARTICLE_COLUMNS = 'id,constitution_id,chapter,article_number,title,content,ord,source,active,created_at';

let catalogueFailed = false;
const catalogueListeners = new Set<(failed: boolean) => void>();

export const subscribeCatalogueFailed = (fn: (failed: boolean) => void) => {
  catalogueListeners.add(fn);
  fn(catalogueFailed);
  return () => {
    catalogueListeners.delete(fn);
  };
};

const setCatalogueFailed = (failed: boolean) => {
  catalogueFailed = failed;
  catalogueListeners.forEach((l) => l(failed));
};

const loadConstitutions = async (): Promise<Constitution[]> => {
  const byId = new Map<string, Constitution>(
    bundledConstitutions.map((c) => [c.id, { ...c, indexed: true }]),
  );

  if (!isPlaceholderEnv) {
    try {
      const { data, error } = await supabase.from('constitutions').select('*');
      if (error) throw error;
      if (data) {
        for (const row of data as Constitution[]) {
          const existing = byId.get(row.id);
          byId.set(row.id, { ...existing, ...row, indexed: true });
        }
      }
      setCatalogueFailed(false);
    } catch (err) {
      console.warn('[api] Supabase constitutions fetch failed; using the bundled countries.', err);
      setCatalogueFailed(true);
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    if (!!a.indexed !== !!b.indexed) return a.indexed ? -1 : 1;
    return a.country.localeCompare(b.country);
  });
};

let constitutionsLoad: Promise<Constitution[]> | null = null;

export const fetchConstitutions = (): Promise<Constitution[]> => {
  if (!constitutionsLoad) {
    constitutionsLoad = loadConstitutions().then((cs) => {
      if (catalogueFailed) constitutionsLoad = null;
      return cs;
    });
  }
  return constitutionsLoad;
};

export const fetchArticles = async (
  constitutionId: string,
): Promise<Article[]> => {
  const bundled = bundledArticles.filter(
    (a) => a.constitution_id === constitutionId,
  );

  if (isPlaceholderEnv) return bundled;
  try {
    const { data, error } = await supabase
      .from('articles')
      .select(ARTICLE_COLUMNS)
      .eq('constitution_id', constitutionId)
      .eq('active', true)
      .order('ord', { ascending: true, nullsFirst: false });
    if (error) throw error;
    if (!data || data.length === 0) return bundled;
    return data as Article[];
  } catch (err) {
    console.warn('[api] articles fetch failed, using bundled.', err);
    return bundled;
  }
};

export const fetchAllArticles = async (): Promise<Article[]> => {
  if (isPlaceholderEnv) return bundledArticles;
  const PAGE_SIZE = 1000;
  try {
    const all: Article[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('articles')
        .select(ARTICLE_COLUMNS)
        .eq('active', true)
        .order('constitution_id', { ascending: true })
        .order('ord', { ascending: true, nullsFirst: false })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      all.push(...(data as Article[]));
      if (data.length < PAGE_SIZE) break;
    }
    if (all.length === 0) return bundledArticles;
    console.info(`[api] fetched ${all.length} articles from Supabase.`);
    return all;
  } catch (err) {
    console.warn('[api] all-articles fetch failed, using bundled.', err);
    return bundledArticles;
  }
};

export const fetchArticlesByIds = async (ids: string[]): Promise<Article[]> => {
  const wanted = new Set(ids);
  const bundledFor = (missing: Set<string>) =>
    bundledArticles.filter((a) => missing.has(a.id));
  if (isPlaceholderEnv || wanted.size === 0) return bundledFor(wanted);
  // Chunked so the id list never makes the request URL too long.
  const CHUNK_SIZE = 100;
  const unique = Array.from(wanted);
  try {
    const found: Article[] = [];
    for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
      const { data, error } = await supabase
        .from('articles')
        .select(ARTICLE_COLUMNS)
        .in('id', unique.slice(i, i + CHUNK_SIZE))
        .eq('active', true);
      if (error) throw error;
      if (data) found.push(...(data as Article[]));
    }
    for (const a of found) wanted.delete(a.id);
    return [...found, ...bundledFor(wanted)];
  } catch (err) {
    console.warn('[api] articles-by-id fetch failed, using bundled.', err);
    return bundledFor(wanted);
  }
};

export interface ArticleSearchHit extends Article {
  rank: number;
  matched_all: boolean;
}

const runSearch = async (
  query: string,
  countryIds: string[],
  k: number,
): Promise<ArticleSearchHit[] | null> => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { data, error } = await supabase.rpc('search_articles', {
      query,
      country_ids: countryIds.length ? countryIds : null,
      k,
    });
    if (!error) return (data ?? []) as ArticleSearchHit[];
    console.warn(
      attempt === 1
        ? '[api] search_articles failed, retrying once.'
        : '[api] search_articles failed, using the in-browser index.',
      error,
    );
  }
  return null;
};

const searchCache = new Map<string, Promise<ArticleSearchHit[] | null>>();

// One retry before giving up, since the fallback downloads the whole corpus. Results are kept for
// the session, so asking again or quizzing on an answer does not repeat the search.
export const searchArticles = (
  query: string,
  countryIds: string[],
  k: number,
): Promise<ArticleSearchHit[] | null> => {
  if (isPlaceholderEnv) return Promise.resolve(null);
  const key = JSON.stringify([query, [...countryIds].sort(), k]);
  const cached = searchCache.get(key);
  if (cached) return cached;
  const pending = runSearch(query, countryIds, k);
  searchCache.set(key, pending);
  pending.then((hits) => {
    if (hits === null) searchCache.delete(key);
  });
  return pending;
};
