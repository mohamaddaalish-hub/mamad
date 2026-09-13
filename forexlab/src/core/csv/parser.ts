/**
 * Dependency-free CSV scanner.
 *
 * Handles quoted fields, embedded delimiters/newlines, CRLF/LF/CR, and can be
 * driven in chunks so a multi-hundred-megabyte file never has to be materialised
 * as one string. Rows are emitted as raw string cells; interpretation lives in
 * `columns.ts` / `validate.ts`.
 */

export interface SplitOptions {
  delimiter?: string;
  quote?: string;
}

/** Detect the delimiter used consistently across the first rows of `sample`. */
export function sniffDelimiter(sample: string): string {
  const lines = sample
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(0, 40);
  if (lines.length === 0) return ',';
  let best = ',';
  let bestScore = -Infinity;
  for (const d of [',', ';', '\t', '|']) {
    const per: number[] = [];
    for (const line of lines) {
      let c = 0;
      let inQuote = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') inQuote = !inQuote;
        else if (ch === d && !inQuote) c++;
      }
      per.push(c);
    }
    const mean = per.reduce((a, b) => a + b, 0) / per.length;
    let variance = 0;
    for (const p of per) variance += (p - mean) ** 2;
    variance /= per.length;
    const score = mean > 0 ? mean / (1 + Math.sqrt(variance)) : -1;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** Safety valve for a stray unterminated quote (records are normally < 1 KB). */
const MAX_PENDING_RECORD = 2 * 1024 * 1024;

export interface RowSink {
  row(cells: string[], rowIndex: number): void;
}

/**
 * Incremental record scanner: feed it text pieces (decoded file slices) and it
 * emits whole records. Only one record can be pending at a time, so memory stays
 * flat regardless of file size.
 */
export class CsvScanner {
  readonly delimiter: string;
  readonly quote: string;
  /**
   * Text of the record that has not been terminated yet. The scanner always
   * re-scans it from the record start, which keeps quote state derivation
   * trivially correct across chunk boundaries.
   */
  private carry = '';
  private rowIndex = 0;

  constructor(opts: SplitOptions = {}) {
    this.delimiter = opts.delimiter ?? ',';
    this.quote = opts.quote ?? '"';
  }

  get linesSeen(): number {
    return this.rowIndex;
  }

  push(text: string, sink: RowSink, isLast = false): void {
    if (text.length === 0) {
      if (isLast) this.finish(sink);
      return;
    }
    const src = this.carry.length > 0 ? this.carry + text : text;
    this.carry = '';
    const q = this.quote;
    let pos = 0;
    let inQ = false;
    let i = pos;
    while (i < src.length) {
      const ch = src[i];
      if (inQ) {
        if (ch === q) {
          if (src[i + 1] === q) i++;
          else inQ = false;
        }
        i++;
        continue;
      }
      if (ch === q) {
        inQ = true;
        i++;
        continue;
      }
      if (ch === '\n') {
        this.emit(src.slice(pos, i), sink);
        pos = i + 1;
        i++;
        continue;
      }
      i++;
    }
    if (pos < src.length) {
      if (isLast) this.emit(src.slice(pos), sink);
      else if (src.length - pos > MAX_PENDING_RECORD) {
        // Pathological unterminated quote: emit what we have so the importer can
        // report it, instead of growing the carry forever.
        this.emit(src.slice(pos), sink);
      } else this.carry = src.slice(pos);
    }
    if (isLast) this.finish(sink);
  }

  private finish(sink: RowSink): void {
    if (this.carry.length > 0) {
      const tail = this.carry;
      this.carry = '';
      this.emit(tail, sink);
    }
    void sink;
  }

  private emit(line: string, sink: RowSink): void {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (trimmed.length === 0) {
      this.rowIndex++;
      return;
    }
    sink.row(splitRecord(trimmed, this.delimiter, this.quote), this.rowIndex++);
  }
}

/** Split one complete record into cells (quote aware). */
export function splitRecord(line: string, delimiter = ',', quote = '"'): string[] {
  if (line.indexOf(quote) === -1) return line.split(delimiter);
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === quote) {
        if (line[i + 1] === quote) {
          cur += quote;
          i++;
        } else inQ = false;
      } else cur += ch;
      continue;
    }
    if (ch === quote) {
      inQ = true;
      continue;
    }
    if (ch === delimiter) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** One-shot helper for tests and small in-memory strings. */
export function parseCsv(text: string, opts: SplitOptions = {}): string[][] {
  const delimiter = opts.delimiter ?? sniffDelimiter(text.slice(0, 8192));
  const out: string[][] = [];
  const scanner = new CsvScanner({ ...opts, delimiter });
  scanner.push(text, { row: (cells) => out.push(cells) }, true);
  return out;
}
