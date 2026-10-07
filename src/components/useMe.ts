import { useEffect, useState } from 'preact/hooks';
import { getMe } from '../lib/api';
import type { Me } from '../lib/types';

/** The signed-in user (shared, cached request). Null until loaded. */
export function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    getMe().then(setMe, () => undefined);
  }, []);
  return me;
}
