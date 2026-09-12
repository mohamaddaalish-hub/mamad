/**
 * Main-thread import orchestration.
 *
 * The heavy parse always runs in `marketCsv.worker.ts`; this module only probes a
 * small head sample for the mapping UI, tracks progress and re-emits diagnostics.
 */

import { parseCsv, sniffDelimiter } from './parser.ts';
import { detectColumns, letter, type ColumnMap, type ColumnRole } from './columns.ts';
import type { ImportReport, MarketImportOptions } from './market.ts';
import type { CandleColumns } from '../data/types.ts';

export interface ProbeResult {
  name: string;
  bytes: number;
  delimiter: string;
  header: string[];
  preview: string[][];
  detected: ColumnMap;
  estimatedRows: number;
  notes: string[];
  error?: string;
}

const PROBE_BYTES = 256 * 1024;

export async function probeMarketFile(file: File | Blob, name = 'data.csv'): Promise<ProbeResult> {
  const head = await file.slice(0, PROBE_BYTES).text();
  return probeText(head, name, file.size);
}

/** Public for tests and for drag-and-drop of in-memory text. */
export function probeText(text: string, name: string, bytes = text.length): ProbeResult {
  const notes: string[] = [];
  if (!text.trim()) {
    return {
      name, bytes, delimiter: ',', header: [], preview: [],
      detected: { roles: {}, confidence: 0, notes: ['file appears empty'], hasHeader: false, delimiter: ',' },
      estimatedRows: 0, notes: ['The first 256 KB contain no readable text.'],
      error: 'empty file',
    };
  }
  const delimiter = sniffDelimiter(text.slice(0, 8192));
  const rows = parseCsv(text, { delimiter });
  const detected = detectColumns(rows, { delimiter });
  const preview = rows.slice(detected.hasHeader ? 1 : 0, (detected.hasHeader ? 1 : 0) + 12);
  const avgLineLen = Math.max(1, Math.round(text.length / Math.max(1, rows.length)));
  const estimatedRows = Math.round(bytes / avgLineLen);
  notes.push(`delimiter "${describeDelimiter(delimiter)}"`, detected.hasHeader ? 'header row detected' : 'no header row — columns mapped by content');
  for (const note of detected.notes) notes.push(note);
  const required: ColumnRole[] = ['date', 'open', 'high', 'low', 'close'];
  const missing = required.filter((r) => detected.roles[r] === undefined);
  if (missing.length > 0) {
    notes.push(`needs manual mapping: ${missing.map((r) => `${r} (${letter(0)})`).join(', ')}`);
  }
  return {
    name, bytes, delimiter,
    header: detected.hasHeader ? rows[0] : rows[0].map((_, i) => `${letter(i)} (unnamed)`),
    preview, detected, estimatedRows, notes,
  };
}

export function describeDelimiter(d: string): string {
  if (d === ',') return 'comma';
  if (d === ';') return 'semicolon';
  if (d === '\t') return 'tab';
  if (d === '|') return 'pipe';
  return JSON.stringify(d);
}

export interface ImportProgress {
  ratio: number;
  lines: number;
  bytes: number;
}

export interface ImportOutcome {
  cols: CandleColumns;
  report: ImportReport;
  finerThanSource: boolean;
}

interface WorkerDoneMessage {
  kind: 'done';
  jobId: string;
  buffers: Record<string, ArrayBuffer>;
  len: number;
  report: ImportReport;
  finerThanSource: boolean;
}

type WorkerMessage =
  | { kind: 'progress'; jobId: string; lines: number; bytes: number; ratio: number }
  | WorkerDoneMessage
  | { kind: 'error'; jobId: string; message: string; hint?: string };

let worker: Worker | null = null;
let queue = 0;

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../../workers/marketCsv.worker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('error', (e) => {
    console.error('[importer] worker error', e.message);
  });
  return worker;
}

/**
 * Parse a market CSV in the worker. `file` may be a real File (browser) or an
 * object with `text` (tests / pasted content).
 */
export async function importMarketCsv(params: {
  file?: File | Blob;
  text?: string;
  fileName?: string;
  bytes?: number;
  delimiter?: string;
  map: Partial<Record<ColumnRole, number>>;
  opts: MarketImportOptions;
  onProgress?: (p: ImportProgress) => void;
  signal?: AbortSignal;
}): Promise<ImportOutcome> {
  const jobId = `job_${Date.now().toString(36)}_${queue++}`;
  const w = getWorker();
  return new Promise<ImportOutcome>((resolve, reject) => {
    const onMessage = (event: MessageEvent<WorkerMessage>) => {
      const msg = event.data;
      if (!msg || msg.jobId !== jobId) return;
      if (msg.kind === 'progress') {
        params.onProgress?.({ ratio: msg.ratio, lines: msg.lines, bytes: msg.bytes });
        return;
      }
      cleanup();
      if (msg.kind === 'error') {
        reject(new Error(msg.hint ? `${msg.message} — ${msg.hint}` : msg.message));
        return;
      }
      const done = msg;
      const b = done.buffers;
      const cols: CandleColumns = {
        t: new Float64Array(b.t),
        o: new Float64Array(b.o),
        h: new Float64Array(b.h),
        l: new Float64Array(b.l),
        c: new Float64Array(b.c),
        v: new Float64Array(b.v),
        n: new Uint32Array(b.n),
        len: done.len,
      };
      resolve({ cols, report: done.report, finerThanSource: done.finerThanSource });
    };
    const onAbort = () => {
      w.postMessage({ kind: 'cancel', jobId });
      cleanup();
      reject(new Error('Import cancelled.'));
    };
    const cleanup = () => {
      w.removeEventListener('message', onMessage);
      params.signal?.removeEventListener('abort', onAbort);
    };
    w.addEventListener('message', onMessage);
    params.signal?.addEventListener('abort', onAbort);
    w.postMessage({
      kind: 'parse',
      jobId,
      file: params.file,
      text: params.text,
      fileName: params.fileName ?? 'data.csv',
      bytes: params.bytes ?? params.file?.size ?? 0,
      delimiter: params.delimiter,
      map: params.map,
      opts: params.opts,
    });
  });
}

/** Estimate a dataset label from a file name (e.g. "EURUSD_M1_2020.csv" → EURUSD). */
export function symbolFromFileName(name: string): string | null {
  const m = /([A-Z]{6})/i.exec(name.replace(/[^A-Za-z]/g, ' '));
  if (m) return m[1].toUpperCase();
  return null;
}
