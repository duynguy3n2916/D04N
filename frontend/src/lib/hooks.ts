import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from './api';

/** Tải dữ liệu bất đồng bộ, hủy khi deps đổi, có reload(). */
export function useAsync<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    setError(null);
    fnRef.current(ctl.signal)
      .then((d) => { if (!ctl.signal.aborted) { setData(d); setLoading(false); } })
      .catch((e) => { if (!ctl.signal.aborted && e?.name !== 'AbortError') { setError(errorText(e)); setLoading(false); } });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

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
