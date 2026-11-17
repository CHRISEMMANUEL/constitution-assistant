
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  fetchArticles,
  fetchConstitutions,
  type Article,
  type Constitution,
} from '../services/api';

interface DataContextValue {
  constitutions: Constitution[];
  constitutionsLoading: boolean;
  getArticles: (constitutionId: string) => Promise<Article[]>;
}

const DataContext = createContext<DataContextValue | null>(null);

export const DataProvider = ({ children }: { children: ReactNode }) => {
  const [constitutions, setConstitutions] = useState<Constitution[]>([]);
  const [constitutionsLoading, setConstitutionsLoading] = useState(true);

  const articlesCache = useRef<Map<string, Article[]>>(new Map());
  const articlesPromise = useRef<Map<string, Promise<Article[]>>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const delays = [0, 1500, 4000];
      for (const wait of delays) {
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        try {
          const data = await fetchConstitutions();
          if (cancelled) return;
          if (data.length > 0) {
            setConstitutions(data);
            setConstitutionsLoading(false);
            return;
          }
        } catch (err) {
          console.warn('[data] fetchConstitutions failed; retrying', err);
        }
      }
      if (!cancelled) setConstitutionsLoading(false);
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const getArticles = useCallback(async (id: string): Promise<Article[]> => {
    const hit = articlesCache.current.get(id);
    if (hit) return hit;
    const pending = articlesPromise.current.get(id);
    if (pending) return pending;
    const p = fetchArticles(id).then((rows) => {
      articlesCache.current.set(id, rows);
      articlesPromise.current.delete(id);
      return rows;
    });
    articlesPromise.current.set(id, p);
    return p;
  }, []);

  return (
    <DataContext.Provider
      value={{
        constitutions,
        constitutionsLoading,
        getArticles,
      }}
    >
      {children}
    </DataContext.Provider>
  );
};

export const useData = (): DataContextValue => {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used inside <DataProvider>');
  return ctx;
};
