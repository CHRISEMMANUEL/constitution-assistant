import { supabase } from '../lib/supabase';
import {
  constitutions as bundledConstitutions,
  articles as bundledArticles,
  type BundledArticle,
  type BundledConstitution,
  type Region,
} from '../data/constitutions';
import { fetchAllCountries, type CountryProfile } from './countries';

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
export interface Article extends BundledArticle {}
export type { Region };

const isPlaceholderEnv = !import.meta.env.VITE_SUPABASE_URL;

const ARTICLE_COLUMNS = 'id,constitution_id,chapter,article_number,title,content,ord,source,active,created_at';

const profileToConstitution = (p: CountryProfile): Constitution => ({
  id: p.id,
  country: p.country,
  country_code: p.country_code,
  flag: p.flag,
  flag_image_url: p.flag_image_url,
  region: p.region,
  subregion: p.subregion,
  capital: p.capital,
  population: p.population,
  languages: p.languages,
  title: '',
  adopted: '',
  summary: '',
  indexed: false,
});

export const fetchConstitutions = async (): Promise<Constitution[]> => {
  const byId = new Map<string, Constitution>(
    bundledConstitutions.map((c) => [c.id, { ...c, indexed: true }]),
  );

  try {
    const profiles = await fetchAllCountries();
    for (const p of profiles) {
      const existing = byId.get(p.id);
      if (existing) {
        byId.set(p.id, {
          ...existing,
          flag_image_url: p.flag_image_url,
          capital: p.capital,
          population: p.population,
          languages: p.languages,
          subregion: p.subregion,
        });
      } else {
        byId.set(p.id, profileToConstitution(p));
      }
    }
  } catch (err) {
    console.warn('[api] REST Countries fetch failed, continuing without it.', err);
  }

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
    } catch (err) {
      console.warn('[api] Supabase constitutions fetch failed; using merged bundled + REST.', err);
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    if (!!a.indexed !== !!b.indexed) return a.indexed ? -1 : 1;
    return a.country.localeCompare(b.country);
  });
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

export const searchArticles = async (
  query: string,
  countryIds: string[],
  k: number,
): Promise<ArticleSearchHit[] | null> => {
  if (isPlaceholderEnv) return null;
  const { data, error } = await supabase.rpc('search_articles', {
    query,
    country_ids: countryIds.length ? countryIds : null,
    k,
  });
  if (error) {
    console.warn('[api] search_articles failed, using the in-browser index.', error);
    return null;
  }
  return (data ?? []) as ArticleSearchHit[];
};
