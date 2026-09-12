/**
 * Import orchestration used by the UI: probe → confirm mapping → worker parse →
 * register in the local library → open on the chart.
 */

import { importStore, defaultImportOptions, type ImportOptions } from './importStore.ts';
import { importMarketCsv, probeMarketFile, symbolFromFileName, type ImportProgress } from './importer.ts';
import type { ColumnRole } from './columns.ts';
import { datasetRecordFromReport, openDataset, registerImportedDataset } from '../app/actions.ts';
import { pushDiagnostic } from '../app/state.ts';

let controller: AbortController | null = null;

export async function adoptMarketFile(file: File | Blob, name?: string): Promise<void> {
  const fileName = name ?? (file as File).name ?? 'pasted.csv';
  importStore.set({
    dialogOpen: true,
    phase: 'probing',
    error: null,
    outcome: null,
    progress: null,
    source: { name: fileName, size: file.size, file },
  });
  try {
    const probe = await probeMarketFile(file, fileName);
    const guess = symbolFromFileName(fileName);
    const opts: ImportOptions = {
      ...defaultImportOptions,
      symbol: guess ?? importStore.get().opts.symbol,
      delimiter: probe.delimiter,
      dayFirst: probe.detected.dayFirst ?? false,
    };
    importStore.set({ phase: 'mapping', probe, roles: probe.detected.roles, opts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    importStore.set({ phase: 'error', error: `Could not read the file: ${message}` });
    pushDiagnostic('error', `Import probe failed: ${message}`);
  }
}

export function setRole(role: ColumnRole, column: number | null): void {
  const roles = { ...importStore.get().roles };
  if (column === null) delete roles[role];
  else roles[role] = column;
  importStore.set({ roles });
}

export function setImportOptions(patch: Partial<ImportOptions>): void {
  importStore.set({ opts: { ...importStore.get().opts, ...patch } });
}

export async function runImport(): Promise<string | null> {
  const state = importStore.get();
  const source = state.source;
  if (!source) {
    importStore.set({ error: 'Choose a CSV file first.' });
    return null;
  }
  const missing = (['date', 'open', 'high', 'low', 'close'] as ColumnRole[]).filter((r) => state.roles[r] === undefined);
  if (missing.length > 0) {
    importStore.set({ error: `Map these columns before importing: ${missing.join(', ')}` });
    return null;
  }
  controller = new AbortController();
  importStore.set({ phase: 'running', error: null, progress: { ratio: 0, lines: 0, bytes: 0 } });
  let lastTick = 0;
  try {
    const outcome = await importMarketCsv({
      file: source.file ?? undefined,
      text: source.text,
      fileName: source.name,
      bytes: source.size,
      delimiter: state.opts.delimiter || undefined,
      map: state.roles,
      opts: {
        symbol: state.opts.symbol,
        fileName: source.name,
        tf: state.opts.tf,
        tz: state.opts.tz,
        dayFirst: state.opts.dayFirst,
        decimalSeparator: state.opts.decimalSeparator,
        timestampMode: state.opts.timestampMode,
        dedupe: state.opts.dedupe,
      },
      signal: controller.signal,
      onProgress: (p: ImportProgress) => {
        // Throttle store writes so a fast file does not repaint 200×/s.
        if (p.ratio >= 1 || Date.now() - lastTick > 90) {
          lastTick = Date.now();
          importStore.set({ progress: p });
        }
      },
    });
    const meta = datasetRecordFromReport(outcome.report, source.size, source.name);
    const record = await registerImportedDataset(outcome.cols, meta, { open: true });
    importStore.set({
      phase: 'done',
      outcome,
      progress: { ratio: 1, lines: outcome.report.totalLines, bytes: source.size },
      produced: [{ id: record.id, symbol: record.symbol, tf: record.tf, count: record.count }, ...importStore.get().produced].slice(0, 10),
    });
    pushDiagnostic(
      'info',
      `Imported ${record.symbol} ${record.tf}: ${record.count.toLocaleString()} bars from ${source.name}`,
    );
    await openDataset(record.id);
    return record.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/cancel/i.test(message)) {
      importStore.set({ phase: 'mapping', progress: null, error: 'Import cancelled.' });
    } else {
      importStore.set({ phase: 'error', error: message });
      pushDiagnostic('error', `Import failed: ${message}`);
    }
    return null;
  } finally {
    controller = null;
  }
}

export function cancelImport(): void {
  controller?.abort();
  controller = null;
}

/** Import straight to the library without opening the dialog (drag & drop). */
export async function quickImport(file: File): Promise<void> {
  await adoptMarketFile(file);
  const state = importStore.get();
  const missing = (['date', 'open', 'high', 'low', 'close'] as ColumnRole[]).filter((r) => state.roles[r] === undefined);
  if (missing.length === 0 && state.probe && state.probe.detected.confidence >= 0.9) {
    await runImport();
    importStore.set({ dialogOpen: false });
  }
}
