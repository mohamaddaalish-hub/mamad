/**
 * Minimal IndexedDB layer. Everything the user imports stays in the browser:
 * no uploads, no server, and the app keeps working offline after a reload.
 *
 * Layout
 *   datasets   key: id            → DatasetRecord (metadata + import report)
 *   news       key: id            → NewsRecord   (metadata + import report)
 *   blobs      key: `${ref}:${name}` → ArrayBuffer | chunked payload
 *   sessions   key: id            → BacktestSession
 *   kv         key: string        → settings, filter presets, watchlist
 */

export const DB_NAME = 'forexlab';
export const DB_VERSION = 1;

export type StoreName = 'datasets' | 'news' | 'blobs' | 'sessions' | 'kv';
export const STORES: readonly StoreName[] = ['datasets', 'news', 'blobs', 'sessions', 'kv'];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this environment'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('failed to open IndexedDB'));
    req.onblocked = () => reject(new Error('IndexedDB open request was blocked by another tab'));
  });
  return dbPromise;
}

async function tx<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const req = run(transaction.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error(`IndexedDB ${mode} failed on ${store}`));
    transaction.onabort = () => reject(transaction.error ?? new Error(`transaction aborted on ${store}`));
  });
}

export function put(store: StoreName, value: unknown, key: IDBValidKey): Promise<IDBValidKey> {
  return tx(store, 'readwrite', (s) => s.put(value, key));
}

export function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return tx<T>(store, 'readonly', (s) => s.get(key) as IDBRequest<T>);
}

export function del(store: StoreName, key: IDBValidKey): Promise<undefined> {
  return tx(store, 'readwrite', (s) => s.delete(key));
}

export function allKeys(store: StoreName): Promise<IDBValidKey[]> {
  return tx(store, 'readonly', (s) => s.getAllKeys() as IDBRequest<IDBValidKey[]>);
}

export function all<T>(store: StoreName): Promise<T[]> {
  return tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}

export function keysWithPrefix(store: StoreName, prefix: string): Promise<IDBValidKey[]> {
  return new Promise(async (resolve, reject) => {
    try {
      const db = await openDb();
      const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
      const req = db.transaction(store, 'readonly').objectStore(store).getAllKeys(range);
      req.onsuccess = () => resolve(req.result as IDBValidKey[]);
      req.onerror = () => reject(req.error);
    } catch (err) {
      reject(err);
    }
  });
}

export async function deleteWithPrefix(store: StoreName, prefix: string): Promise<number> {
  const keys = await keysWithPrefix(store, prefix);
  for (const k of keys) await del(store, k);
  return keys.length;
}

export async function clearStore(store: StoreName): Promise<void> {
  await tx(store, 'readwrite', (s) => s.clear());
}

/** Rough quota readout for the storage indicator in Settings. */
export async function estimateUsage(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
}
