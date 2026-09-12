/**
 * Import flow state. Kept outside the main app store because progress ticks fire
 * many times per second while a worker parses a large file.
 */

import { createStore, useSlice } from '../store/state.ts';
import type { ColumnRole } from './columns.ts';
import type { ImportProgress, ImportOutcome, ProbeResult } from './importer.ts';
import type { TimeframeId } from '../time/timeframes.ts';

export type ImportPhase = 'idle' | 'probing' | 'mapping' | 'running' | 'done' | 'error';

export interface ImportFileState {
  name: string;
  size: number;
  file: File | Blob | null;
  /** Raw text when the source was pasted rather than a real file. */
  text?: string;
}

export interface ImportOptions {
  symbol: string;
  tf: TimeframeId | 'auto';
  tz: string;
  dayFirst: boolean;
  decimalSeparator: '.' | ',' | 'auto';
  timestampMode: 'open' | 'close';
  dedupe: 'first' | 'last' | 'reject';
  delimiter: string;
}

export interface ImportState {
  dialogOpen: boolean;
  phase: ImportPhase;
  source: ImportFileState | null;
  probe: ProbeResult | null;
  roles: Partial<Record<ColumnRole, number>>;
  opts: ImportOptions;
  progress: ImportProgress | null;
  outcome: ImportOutcome | null;
  error: string | null;
  /** Datasets produced in this session, newest first. */
  produced: { id: string; symbol: string; tf: TimeframeId; count: number }[];
}

export const defaultImportOptions: ImportOptions = {
  symbol: 'EURUSD',
  tf: 'auto',
  tz: 'UTC',
  dayFirst: false,
  decimalSeparator: 'auto',
  timestampMode: 'open',
  dedupe: 'first',
  delimiter: '',
};

export const importStore = createStore<ImportState>({
  dialogOpen: false,
  phase: 'idle',
  source: null,
  probe: null,
  roles: {},
  opts: defaultImportOptions,
  progress: null,
  outcome: null,
  error: null,
  produced: [],
});

export function useImport<K>(select: (s: ImportState) => K): K {
  return useSlice(importStore, select);
}

export const ROLE_ORDER: ColumnRole[] = ['date', 'time', 'open', 'high', 'low', 'close', 'volume', 'symbol'];
export const ROLE_LABELS: Record<ColumnRole, string> = {
  date: 'Date / datetime',
  time: 'Time',
  open: 'Open',
  high: 'High',
  low: 'Low',
  close: 'Close',
  volume: 'Volume',
  symbol: 'Symbol',
};
export const ROLE_REQUIRED: ColumnRole[] = ['date', 'open', 'high', 'low', 'close'];

export function openImportDialog(): void {
  importStore.set({ dialogOpen: true, error: null });
}

export function closeImportDialog(): void {
  const s = importStore.get();
  importStore.set({
    dialogOpen: false,
    phase: 'idle',
    progress: null,
    source: s.phase === 'done' ? null : s.source,
    probe: s.phase === 'done' ? null : s.probe,
    outcome: s.phase === 'done' ? null : s.outcome,
  });
}
