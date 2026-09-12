/**
 * Background market-CSV import.
 *
 * Reads the file in 8 MB slices, decodes incrementally, and feeds a
 * MarketCsvBuilder row by row, so the main thread stays free and memory stays
 * flat for very large files. Buffers are transferred back (no structured clone
 * copy of hundreds of megabytes).
 */

/// <reference lib="webworker" />
import { CsvScanner, sniffDelimiter } from '../core/csv/parser.ts';
import { MarketCsvBuilder, type MarketBuildResult, type MarketImportOptions } from '../core/csv/market.ts';
import type { ColumnRole } from '../core/csv/columns.ts';

export interface ParseRequest {
  kind: 'parse';
  jobId: string;
  file?: File;
  text?: string;
  fileName: string;
  bytes: number;
  delimiter?: string;
  map: Partial<Record<ColumnRole, number>>;
  opts: MarketImportOptions;
  progressEveryMs?: number;
}

export interface CancelRequest {
  kind: 'cancel';
  jobId: string;
}

export type WorkerRequest = ParseRequest | CancelRequest;

export interface WorkerProgress {
  kind: 'progress';
  jobId: string;
  lines: number;
  bytes: number;
  ratio: number;
  rows: number;
}

export interface WorkerDone {
  kind: 'done';
  jobId: string;
  buffers: Record<string, ArrayBuffer>;
  len: number;
  report: MarketBuildResult['report'];
  finerThanSource: boolean;
}

export interface WorkerError {
  kind: 'error';
  jobId: string;
  message: string;
  hint?: string;
}

const CHUNK = 8 * 1024 * 1024;

let cancelled = new Set<string>();

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.kind === 'cancel') {
    cancelled.add(msg.jobId);
    return;
  }
  void run(msg).catch((err: unknown) => {
    const payload: WorkerError = {
      kind: 'error',
      jobId: msg.jobId,
      message: err instanceof Error ? err.message : String(err),
      hint: 'Check the column mapping and timezone, then re-run the import.',
    };
    (self as unknown as Worker).postMessage(payload);
  });
};

async function run(req: ParseRequest): Promise<void> {
  const post = (msg: WorkerProgress | WorkerDone | WorkerError, transfer?: Transferable[]) => {
    (self as unknown as Worker).postMessage(msg, transfer ?? []);
  };
  cancelled.delete(req.jobId);
  const builder = new MarketCsvBuilder({ ...req.opts, fileName: req.fileName });
  builder.setMap(req.map);
  let sample = '';
  if (req.file) {
    const head = new Uint8Array(await req.file.slice(0, 64 * 1024).arrayBuffer());
    sample = new TextDecoder('utf-8').decode(head);
  } else if (req.text) sample = req.text.slice(0, 64 * 1024);
  const delimiter = req.delimiter && req.delimiter.length > 0 ? req.delimiter : sniffDelimiter(sample);
  const scanner = new CsvScanner({ delimiter });
  const sink = {
    row: (cells: string[]) => builder.feed(cells),
  };
  const totalBytes = req.bytes || (req.file?.size ?? 0);
  let bytesRead = 0;
  let lastPost = 0;
  const progressEvery = req.progressEveryMs ?? 120;

  const tick = (force = false) => {
    const now = Date.now();
    if (!force && now - lastPost < progressEvery) return;
    lastPost = now;
    post({
      kind: 'progress',
      jobId: req.jobId,
      lines: builder.linesSeen,
      bytes: bytesRead,
      ratio: totalBytes > 0 ? Math.min(1, bytesRead / totalBytes) : 0,
      rows: 0,
    });
  };

  if (req.file) {
    const decoder = new TextDecoder('utf-8');
    let pos = 0;
    const size = req.file.size;
    while (pos < size) {
      if (cancelled.has(req.jobId)) {
        post({ kind: 'error', jobId: req.jobId, message: 'Import cancelled by user.' });
        cancelled.delete(req.jobId);
        return;
      }
      const slice = await req.file.slice(pos, Math.min(pos + CHUNK, size)).arrayBuffer();
      pos += slice.byteLength;
      bytesRead += slice.byteLength;
      const text = decoder.decode(new Uint8Array(slice), { stream: pos < size });
      scanner.push(text, sink, pos >= size);
      tick();
    }
    // Flush any trailing record left in the decoder/scanner.
    const tail = decoder.decode();
    if (tail.length > 0) scanner.push(tail, sink, true);
  } else if (req.text) {
    scanner.push(req.text, sink, true);
    bytesRead = req.text.length;
  } else {
    post({ kind: 'error', jobId: req.jobId, message: 'No file or text supplied to the parser.' });
    return;
  }
  scanner.push('', sink, true);
  const result = builder.finish();
  tick(true);
  const { cols } = result;
  const buffers: Record<string, ArrayBuffer> = {};
  const pairs: [string, Float64Array | Uint32Array][] = [
    ['t', cols.t],
    ['o', cols.o],
    ['h', cols.h],
    ['l', cols.l],
    ['c', cols.c],
    ['v', cols.v],
    ['n', cols.n],
  ];
  const transfer: Transferable[] = [];
  for (const [name, view] of pairs) {
    let buf: ArrayBuffer;
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
      buf = view.buffer as ArrayBuffer;
    } else {
      buf = (view.slice() as unknown as { buffer: ArrayBuffer }).buffer;
    }
    buffers[name] = buf;
    transfer.push(buf);
  }
  if (cancelled.has(req.jobId)) {
    cancelled.delete(req.jobId);
    post({ kind: 'error', jobId: req.jobId, message: 'Import cancelled by user.' });
    return;
  }
  post(
    {
      kind: 'done',
      jobId: req.jobId,
      buffers,
      len: cols.len,
      report: result.report,
      finerThanSource: result.finerThanSource,
    },
    transfer,
  );
}

export {};
