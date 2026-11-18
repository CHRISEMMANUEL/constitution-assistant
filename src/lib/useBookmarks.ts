import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useAuth } from '../context/AuthContext';

export interface BookmarkRecord {
  article_id: string;
  constitution_id: string;
  saved_at: number;
}

export interface RecentRecord {
  constitution_id: string;
  visited_at: number;
}

const BOOKMARKS_KEY = (uid: string) => `lex-bookmarks:${uid}`;
const RECENT_KEY = (uid: string) => `lex-recent:${uid}`;
const RECENT_MAX = 6;

type Listener = () => void;
const listeners = new Set<Listener>();
const notify = () => listeners.forEach((fn) => fn());

const subscribe = (fn: Listener) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

// Same-tab writes call notify(); other tabs fire 'storage'.
const subscribeStore = (fn: Listener) => {
  const off = subscribe(fn);
  window.addEventListener('storage', fn);
  return () => {
    off();
    window.removeEventListener('storage', fn);
  };
};

const readRaw = (key: string): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const parseJson = <T,>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const readJson = <T,>(key: string, fallback: T): T => parseJson(readRaw(key), fallback);

// The snapshot is the raw string, which compares equal between reads, so the list only re-parses when it changes.
const useStoredList = <T,>(key: string): T[] => {
  const raw = useSyncExternalStore(subscribeStore, () => readRaw(key), () => null);
  return useMemo(() => parseJson<T[]>(raw, []), [raw]);
};

const writeJson = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    notify();
  } catch {
    // Storage blocked (private mode) or full: nothing is saved.
  }
};

export const useBookmarks = () => {
  const { user } = useAuth();
  const uid = user?.id ?? 'anon';

  const items = useStoredList<BookmarkRecord>(BOOKMARKS_KEY(uid));

  const isBookmarked = useCallback(
    (articleId: string) => items.some((b) => b.article_id === articleId),
    [items],
  );

  const toggle = useCallback(
    (articleId: string, constitutionId: string) => {
      const current = readJson<BookmarkRecord[]>(BOOKMARKS_KEY(uid), []);
      const exists = current.some((b) => b.article_id === articleId);
      const next = exists
        ? current.filter((b) => b.article_id !== articleId)
        : [
            ...current,
            {
              article_id: articleId,
              constitution_id: constitutionId,
              saved_at: Date.now(),
            },
          ];
      writeJson(BOOKMARKS_KEY(uid), next);
    },
    [uid],
  );

  const remove = useCallback(
    (articleId: string) => {
      const current = readJson<BookmarkRecord[]>(BOOKMARKS_KEY(uid), []);
      writeJson(
        BOOKMARKS_KEY(uid),
        current.filter((b) => b.article_id !== articleId),
      );
    },
    [uid],
  );

  return { items, isBookmarked, toggle, remove };
};

export const useRecentlyViewed = () => {
  const { user } = useAuth();
  const uid = user?.id ?? 'anon';

  const items = useStoredList<RecentRecord>(RECENT_KEY(uid));

  const visit = useCallback(
    (constitutionId: string) => {
      const current = readJson<RecentRecord[]>(RECENT_KEY(uid), []);
      const filtered = current.filter(
        (r) => r.constitution_id !== constitutionId,
      );
      const next: RecentRecord[] = [
        { constitution_id: constitutionId, visited_at: Date.now() },
        ...filtered,
      ].slice(0, RECENT_MAX);
      writeJson(RECENT_KEY(uid), next);
    },
    [uid],
  );

  return { items, visit };
};

export const useTrackVisit = (constitutionId: string | null | undefined) => {
  const { visit } = useRecentlyViewed();
  useEffect(() => {
    if (constitutionId) visit(constitutionId);
  }, [constitutionId, visit]);
};
