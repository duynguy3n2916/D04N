import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText, getToken } from './api';

// Bộ nhớ đệm trong phiên (chỉ khi truyền cacheKey): mở lại một trang đã xem thì hiện ngay dữ liệu lần trước,
// đồng thời tải bản mới ở nền (stale-while-revalidate) nên không phải nhìn vòng "Đang tải" mỗi lần chuyển trang.
// cacheKey phải mô tả đủ dữ liệu được tải (vd. URL); khóa gắn với token nên đổi tài khoản không lẫn dữ liệu.
const cache = new Map<string, unknown>();
const CACHE_MAX = 200;

/** Tải dữ liệu bất đồng bộ, hủy khi deps đổi, có reload(). */
export function useAsync<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[], cacheKey?: string | null) {
  const key = cacheKey ? `${getToken() || ''}|${cacheKey}` : null;
  const cached = key != null && cache.has(key) ? (cache.get(key) as T) : null;
  const [data, setDataState] = useState<T | null>(cached);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(cached == null);
  const keyRef = useRef(key);
  keyRef.current = key;
  const setData = useCallback((v: T | null | ((prev: T | null) => T | null)) => {
    setDataState((prev) => {
      const next = typeof v === 'function' ? (v as (p: T | null) => T | null)(prev) : v;
      if (keyRef.current != null) { if (next == null) cache.delete(keyRef.current); else cache.set(keyRef.current, next); }
      return next;
    });
  }, []);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    const ctl = new AbortController();
    const k = keyRef.current;
    const hit = k != null && cache.has(k);
    if (hit) setDataState(cache.get(k) as T);
    setLoading(!hit);
    setError(null);
    fnRef.current(ctl.signal)
      .then((d) => {
        if (ctl.signal.aborted) return;
        if (k != null) { cache.set(k, d); if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string); }
        setDataState(d); setLoading(false);
      })
      .catch((e) => { if (!ctl.signal.aborted && e?.name !== 'AbortError') { setError(errorText(e)); setLoading(false); } });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, setData, error, loading, reload };
}

export function useInterval(fn: () => void, ms: number | null) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms == null) return;
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}
