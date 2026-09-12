/**
 * CSV import dialog: preview, column mapping, parsing options, progress and the
 * full validation report. Nothing is imported until the mapping is complete, and
 * nothing is repaired silently — every rejected row is listed.
 */

import { useRef } from 'react';
import { Btn, Chip, Field, Modal, ProgressBar, Section, Sel } from '../kit.tsx';
import {
  adoptMarketFile,
  cancelImport,
  runImport,
  setImportOptions,
  setRole,
} from '../../core/csv/importFlow.ts';
import { closeImportDialog, ROLE_LABELS, ROLE_ORDER, ROLE_REQUIRED, useImport } from '../../core/csv/importStore.ts';
import { letter } from '../../core/csv/columns.ts';
import { TIMEFRAME_OPTIONS } from '../../core/time/timeframeOptions.ts';
import { TIMEZONE_OPTIONS, localTimeZone } from '../../core/time/tzList.ts';
import { formatBytes, formatInt, formatNumber } from '../../core/util/format.ts';
import type { TimeframeId } from '../../core/time/timeframes.ts';
import { formatDate } from '../../core/time/tz.ts';
import { useApp } from '../../core/app/state.ts';

export function ImportDialog(): React.ReactElement {
  const state = useImport((s) => s);
  const tz = useApp((s) => s.tz);
  const fileRef = useRef<HTMLInputElement>(null);
  const probe = state.probe;
  const width = probe?.header.length ?? 0;
  const busy = state.phase === 'running' || state.phase === 'probing';
  const missing = ROLE_REQUIRED.filter((r) => state.roles[r] === undefined);

  const columnOptions = [
    { value: -1, label: '— not used —' },
    ...Array.from({ length: width }, (_, i) => {
      const sample = probe?.preview[0]?.[i];
      return {
        value: i,
        label: `${letter(i)} · ${probe?.header[i] ?? i}${sample !== undefined ? `  (${String(sample).slice(0, 14)})` : ''}`,
      };
    }),
  ];

  return (
    <Modal
      title="Import historical market data"
      subtitle="CSV · local only · never uploaded"
      onClose={closeImportDialog}
      footer={
        <>
          <span className="dim" style={{ fontSize: 11 }}>
            {busy
              ? 'Parsing in a background worker — the interface stays responsive.'
              : state.phase === 'done'
                ? 'Dataset stored in this browser (IndexedDB).'
                : missing.length > 0
                  ? `missing mapping: ${missing.join(', ')}`
                  : 'Ready to import.'}
          </span>
          <span style={{ flex: '1 1 auto' }} />
          {state.phase === 'running' ? (
            <Btn variant="ghost" onClick={cancelImport} tip="Stop the worker and discard partial results">
              Cancel
            </Btn>
          ) : null}
          {state.phase === 'done' ? (
            <Btn variant="primary" onClick={closeImportDialog}>
              Done
            </Btn>
          ) : (
            <Btn
              variant="primary"
              disabled={busy || missing.length > 0}
              onClick={() => void runImport()}
              tip="Validate every row, then store the dataset locally and open it"
            >
              Import &amp; open
            </Btn>
          )}
        </>
      }
    >
      <div className="row" style={{ gap: 8, alignItems: 'stretch', marginBottom: 10 }}>
        <div
          className="panel"
          style={{
            flex: '1 1 auto',
            borderStyle: 'dashed',
            borderRadius: 6,
            padding: '14px 12px',
            textAlign: 'center',
            cursor: busy ? 'progress' : 'pointer',
            background: 'var(--bg-sunken)',
          }}
          onClick={() => !busy && fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) void adoptMarketFile(f);
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && fileRef.current?.click()}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt,.tsv,text/csv"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void adoptMarketFile(f);
              e.target.value = '';
            }}
          />
          <div style={{ fontWeight: 600 }}>
            {state.source ? state.source.name : 'Drop a CSV here or click to choose a file'}
          </div>
          <div className="note small dim" style={{ marginTop: 3 }}>
            {state.source
              ? `${formatBytes(state.source.size)} · ${formatInt(state.probe?.estimatedRows ?? 0)} estimated rows`
              : 'Supports Date/Datetime/Timestamp + Time, Open, High, Low, Close, Volume in any column order'}
          </div>
        </div>
      </div>

      {state.error ? <div className="notice error">{state.error}</div> : null}

      {probe ? (
        <Section
          title="Detected layout"
          right={
            <Chip tone={probe.detected.confidence > 0.85 ? 'bull' : 'warn'}>
              {formatNumber(probe.detected.confidence * 100, 0)}% confidence
            </Chip>
          }
        >
          <div className="row wrap" style={{ gap: 4, marginBottom: 6 }}>
            {probe.notes.map((n, i) => (
              <Chip key={i}>{n}</Chip>
            ))}
          </div>
          <div style={{ overflow: 'auto', border: '1px solid var(--border)', borderRadius: 4 }}>
            <table className="table compact">
              <thead>
                <tr>
                  <th style={{ cursor: 'default' }}>line</th>
                  {probe.header.map((h, i) => {
                    const role = (Object.entries(state.roles) as [string, number][]).find(([, col]) => col === i)?.[0];
                    return (
                      <th key={i} style={{ color: role ? 'var(--accent)' : undefined, cursor: 'default' }}>
                        {h}
                        {role ? <span className="dim"> ← {role}</span> : null}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {probe.preview.map((row, r) => (
                  <tr key={r}>
                    <td className="dim">{r + (probe.detected.hasHeader ? 3 : 2)}</td>
                    {probe.header.map((_, c) => (
                      <td key={c} className="num">
                        {row[c] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      <Section title="Column mapping">
        <div className="grid3">
          {ROLE_ORDER.map((role) => (
            <Field key={role} label={ROLE_LABELS[role]} hint={ROLE_REQUIRED.includes(role) ? 'required' : undefined}>
              <Sel
                value={state.roles[role] ?? -1}
                onChange={(v) => setRole(role, v === -1 ? null : (v as number))}
                options={columnOptions}
              />
            </Field>
          ))}
        </div>
      </Section>

      <Section title="Parsing options">
        <div className="grid3">
          <Field label="Symbol">
            <input
              className="input mono"
              value={state.opts.symbol}
              onChange={(e) => setImportOptions({ symbol: e.target.value.toUpperCase() })}
            />
          </Field>
          <Field label="Target timeframe" hint="auto = source spacing">
            <Sel
              value={state.opts.tf}
              onChange={(v) => setImportOptions({ tf: v as TimeframeId | 'auto' })}
              options={[
                { value: 'auto', label: 'Auto-detect', title: 'Use the spacing found in the file' },
                ...TIMEFRAME_OPTIONS.map((o) => ({ ...o, title: `${o.title} — aggregated from the source bars` })),
              ]}
            />
          </Field>
          <Field label="Source timezone" hint={`chart uses ${tz}`}>
            <Sel
              value={state.opts.tz}
              onChange={(v) => setImportOptions({ tz: v })}
              options={[...TIMEZONE_OPTIONS, { value: localTimeZone(), label: `Local · ${localTimeZone()}` }]}
            />
          </Field>
          <Field label="Timestamp marks">
            <Sel
              value={state.opts.timestampMode}
              onChange={(v) => setImportOptions({ timestampMode: v as 'open' | 'close' })}
              options={[
                { value: 'open', label: 'Bar open (most feeds)' },
                { value: 'close', label: 'Bar close (truefx-style) — shift back one bar' },
              ]}
            />
          </Field>
          <Field label="Decimal separator">
            <Sel
              value={state.opts.decimalSeparator}
              onChange={(v) => setImportOptions({ decimalSeparator: v as '.' | ',' | 'auto' })}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: '.', label: 'Dot (1.08530)' },
                { value: ',', label: 'Comma (1,08530)' },
              ]}
            />
          </Field>
          <Field label="Duplicate timestamps">
            <Sel
              value={state.opts.dedupe}
              onChange={(v) => setImportOptions({ dedupe: v as 'first' | 'last' | 'reject' })}
              options={[
                { value: 'first', label: 'Keep first occurrence' },
                { value: 'last', label: 'Keep last occurrence' },
                { value: 'reject', label: 'Drop duplicates' },
              ]}
            />
          </Field>
          <Field label="Ambiguous dates (3/4)">
            <Sel
              value={state.opts.dayFirst ? 'day' : 'month'}
              onChange={(v) => setImportOptions({ dayFirst: v === 'day' })}
              options={[
                { value: 'month', label: 'MM/DD (month first)' },
                { value: 'day', label: 'DD/MM (day first)' },
              ]}
            />
          </Field>
          <Field label="Delimiter">
            <Sel
              value={state.opts.delimiter}
              onChange={(v) => setImportOptions({ delimiter: v })}
              options={[
                { value: '', label: 'Auto-detect' },
                { value: ',', label: 'Comma' },
                { value: ';', label: 'Semicolon' },
                { value: '\t', label: 'Tab' },
                { value: '|', label: 'Pipe' },
              ]}
            />
          </Field>
        </div>
      </Section>

      {state.progress ? (
        <Section title="Progress">
          <ProgressBar
            ratio={state.progress.ratio}
            label={`${formatNumber(state.progress.ratio * 100, 1)}% · ${formatInt(state.progress.lines)} rows · ${formatBytes(state.progress.bytes)}`}
          />
        </Section>
      ) : null}

      {state.outcome ? <ImportReportView report={state.outcome.report} finer={state.outcome.finerThanSource} /> : null}
    </Modal>
  );
}

function ImportReportView({ report, finer }: { report: import('../../core/csv/market.ts').ImportReport; finer: boolean }): React.ReactElement {
  return (
    <Section title="Validation report">
      <div className="row wrap" style={{ gap: 4, marginBottom: 8 }}>
        <Chip tone="bull">{formatInt(report.accepted)} bars accepted</Chip>
        <Chip tone={report.rejected ? 'warn' : undefined}>{formatInt(report.rejected)} rows rejected</Chip>
        <Chip>{formatInt(report.dataRows)} data rows read</Chip>
        <Chip>{formatInt(report.duplicates)} duplicates</Chip>
        <Chip>{report.mergedIntoBuckets ? `${formatInt(report.mergedIntoBuckets)} rows folded` : 'no bucket folding'}</Chip>
        <Chip>{report.gapCount ? `${formatInt(report.gapCount)} gaps · ${formatInt(report.missingBars)} bars absent` : 'no missing bars'}</Chip>
        <Chip>{report.closedSpans ? `${formatInt(report.closedSpans)} market-closed spans` : 'no closure spans'}</Chip>
        <Chip>{report.volumeSeen ? 'volume imported' : 'no volume column'}</Chip>
        <Chip>{formatInt(report.unorderedRows)} rows re-sorted</Chip>
        {report.commentLines > 0 ? <Chip>{formatInt(report.commentLines)} comment lines skipped</Chip> : null}
        <Chip>{report.dateFormat ?? 'date format: n/a'}</Chip>
        <Chip>{report.timeFormat ? `time: ${report.timeFormat}` : 'time: none'}</Chip>
        {report.firstTime !== null && report.lastTime !== null ? (
          <Chip>
            {formatDate(report.firstTime, report.timezone)} → {formatDate(report.lastTime, report.timezone)} ·{' '}
            {formatNumber(report.minLow, 5)} – {formatNumber(report.maxHigh, 5)}
          </Chip>
        ) : null}
      </div>
      {finer ? <div className="notice" style={{ marginBottom: 8 }}>Requested timeframe is finer than the file. Nothing was invented to fill the gap.</div> : null}
      {report.notes.length > 0 ? (
        <div style={{ marginBottom: 8 }}>
          {report.notes.map((n, i) => (
            <div key={i} className="note small dim">
              · {n}
            </div>
          ))}
        </div>
      ) : null}
      {report.invalid.length > 0 ? (
        <div style={{ overflow: 'auto', maxHeight: 160, border: '1px solid var(--border)', borderRadius: 4 }}>
          <table className="table compact">
            <thead>
              <tr>
                <th>Line</th>
                <th>Reason</th>
                <th>Raw row</th>
              </tr>
            </thead>
            <tbody>
              {report.invalid.map((row) => (
                <tr key={row.line}>
                  <td className="num">{row.line}</td>
                  <td className="neg">{row.reason}</td>
                  <td className="dim num">{row.raw}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.rejected > report.invalid.length ? (
            <div className="note small dim" style={{ padding: 6 }}>
              Showing first {report.invalid.length} of {formatInt(report.rejected)} rejected rows.
            </div>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}
