/**
 * Economic-news CSV import: preview → column mapping → validation summary → store.
 * Nothing is stored until the user confirms the summary, and every rejected row
 * is listed with its reason.
 */

import { useMemo, useRef, useState } from 'react';
import { Btn, Chip, Field, Modal, Sel, Check, Section } from '../kit.tsx';
import { closeDialog } from '../../core/app/dialogs.ts';
import { pushDiagnostic, useApp } from '../../core/app/state.ts';
import { TIMEZONE_OPTIONS } from '../../core/time/tzList.ts';
import { formatDate, formatDateTime } from '../../core/time/tz.ts';
import { formatInt } from '../../core/util/format.ts';
import { letter } from '../../core/csv/columns.ts';
import { describeDelimiter } from '../../core/csv/importer.ts';
import {
  NEWS_ROLES,
  NEWS_ROLE_LABEL,
  importNewsText,
  probeNewsText,
  requiredNewsRolesMissing,
  type NewsColumnMap,
  type NewsImportResult,
  type NewsRole,
} from '../../core/econ/csv.ts';
import { newNewsBatchId, newsRegistry, type NewsBatchRecord } from '../../core/econ/store.ts';

type Probe = ReturnType<typeof probeNewsText> & { text: string; name: string; bytes: number };

export function NewsImportDialog(): React.ReactElement {
  const appTz = useApp((s) => s.tz);
  const fileRef = useRef<HTMLInputElement>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [map, setMap] = useState<NewsColumnMap>({});
  const [hasHeader, setHasHeader] = useState(true);
  const [tz, setTz] = useState(appTz);
  const [dayFirst, setDayFirst] = useState(false);
  const [result, setResult] = useState<NewsImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [stored, setStored] = useState(false);

  const width = probe ? Math.max(...probe.rows.map((r) => r.length)) : 0;
  const header = probe && hasHeader ? probe.rows[0] : null;
  const missing = requiredNewsRolesMissing(map);
  const columnOptions = useMemo(
    () => [
      { value: -1, label: '— not used —' },
      ...Array.from({ length: width }, (_, i) => ({
        value: i,
        label: `${letter(i)} · ${header?.[i] ?? `column ${i + 1}`}  (${String(probe?.rows[hasHeader ? 1 : 0]?.[i] ?? '').slice(0, 16)})`,
      })),
    ],
    [width, header, probe, hasHeader],
  );

  const onFile = async (file: File): Promise<void> => {
    if (file.size > 64 * 1024 * 1024) {
      pushDiagnostic('error', 'News CSV larger than 64 MB — split the file');
      return;
    }
    const text = await file.text();
    const p = probeNewsText(text);
    setProbe({ ...p, text, name: file.name, bytes: file.size });
    setMap(p.map);
    setHasHeader(p.hasHeader);
    setResult(null);
    setStored(false);
  };

  const validate = (): void => {
    if (!probe) return;
    setBusy(true);
    // Defer so the button repaints; files are small enough to parse on the main thread.
    setTimeout(() => {
      try {
        const r = importNewsText(probe.text, { tz, dayFirst, delimiter: probe.delimiter, hasHeader, batchId: newNewsBatchId(), map });
        setResult(r);
      } catch (err) {
        pushDiagnostic('error', `News import failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy(false);
      }
    }, 10);
  };

  const store = async (): Promise<void> => {
    if (!result || !probe || result.events.length === 0) return;
    setBusy(true);
    try {
      const id = result.events[0].batchId;
      const record: NewsBatchRecord = {
        id,
        fileName: probe.name,
        createdAt: Date.now(),
        count: result.events.length,
        firstTime: result.summary.firstTime,
        lastTime: result.summary.lastTime,
        tz,
        summary: { ...result.summary, rejectedRows: result.summary.rejectedRows.slice(0, 200) },
      };
      await newsRegistry.addBatch(record, result.events);
      setStored(true);
      pushDiagnostic('info', `${formatInt(result.events.length)} economic events stored locally from ${probe.name}`);
    } catch (err) {
      pushDiagnostic('error', `Could not store news: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const setRole = (role: NewsRole, col: number): void => {
    setMap((m) => {
      const next = { ...m };
      if (col < 0) delete next[role];
      else {
        for (const k of Object.keys(next) as NewsRole[]) if (next[k] === col) delete next[k];
        next[role] = col;
      }
      return next;
    });
    setResult(null);
  };

  return (
    <Modal
      title="Import economic news"
      subtitle="CSV · local only · values are never modified"
      onClose={closeDialog}
      footer={
        <>
          <span className="dim" style={{ fontSize: 11 }}>
            {!probe ? 'Choose a calendar export (CSV).' : missing.length ? `map required columns: ${missing.map((m) => NEWS_ROLE_LABEL[m]).join(', ')}` : result ? (stored ? 'Stored in this browser (IndexedDB).' : 'Review the summary, then store.') : 'Ready to validate.'}
          </span>
          <span style={{ flex: '1 1 auto' }} />
          {stored ? (
            <Btn variant="primary" onClick={closeDialog}>Done</Btn>
          ) : result ? (
            <Btn variant="primary" disabled={busy || result.events.length === 0} onClick={() => void store()}>
              Store {formatInt(result.events.length)} events
            </Btn>
          ) : (
            <Btn variant="primary" disabled={!probe || busy || missing.length > 0} onClick={validate}>
              Validate
            </Btn>
          )}
        </>
      }
    >
      <input
        ref={fileRef}
        type="file"
        accept=".csv,.txt,text/csv"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
          e.currentTarget.value = '';
        }}
      />
      {!probe ? (
        <div
          className="dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) void onFile(f);
          }}
          onClick={() => fileRef.current?.click()}
          role="button"
          tabIndex={0}
        >
          <div style={{ fontWeight: 600 }}>Drop a news CSV here or click to choose</div>
          <div className="note small" style={{ marginTop: 6 }}>
            Supported columns: Date, Time, Datetime, Timestamp, Currency, Country, Impact, Event, Category, Subcategory, Actual, Forecast, Previous, Revised Previous.
            Columns are detected from the header and can be remapped. Missing Actual/Forecast/Previous stay empty — they are never filled in.
          </div>
        </div>
      ) : (
        <>
          <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
            <Chip>{probe.name}</Chip>
            <Chip>{describeDelimiter(probe.delimiter)}</Chip>
            <Chip>{formatInt(probe.rows.length)}+ rows previewed</Chip>
            <Btn size="xs" onClick={() => fileRef.current?.click()}>Choose another file</Btn>
          </div>
          <div className="grid-2">
            <Section title="Options">
              <Field label="File timezone" hint="wall-clock zone of the Date/Time columns">
                <Sel value={tz} onChange={(v) => { setTz(v); setResult(null); }} options={TIMEZONE_OPTIONS} />
              </Field>
              <div className="row wrap" style={{ gap: 12 }}>
                <Check checked={hasHeader} onChange={(v) => { setHasHeader(v); setResult(null); }} label="First row is a header" />
                <Check checked={dayFirst} onChange={(v) => { setDayFirst(v); setResult(null); }} label="Day-first dates (DD/MM/YYYY)" />
              </div>
            </Section>
            <Section title="Column mapping">
              <div className="map-grid">
                {NEWS_ROLES.map((role) => (
                  <Field key={role} label={NEWS_ROLE_LABEL[role]} className={missing.includes(role) || (role === 'currency' && missing.includes('currency')) ? 'missing' : undefined}>
                    <Sel value={map[role] ?? -1} onChange={(v) => setRole(role, Number(v))} options={columnOptions} />
                  </Field>
                ))}
              </div>
            </Section>
          </div>
          <Section title="Preview">
            <div className="scroll-x" style={{ maxHeight: 180, overflow: 'auto' }}>
              <table className="table compact">
                <thead>
                  <tr>
                    {Array.from({ length: width }, (_, i) => {
                      const role = (Object.keys(map) as NewsRole[]).find((k) => map[k] === i);
                      return (
                        <th key={i}>
                          {letter(i)} {role ? <span className="chip accent">{NEWS_ROLE_LABEL[role]}</span> : null}
                          <div className="dim" style={{ textTransform: 'none', fontWeight: 400 }}>{header?.[i] ?? ''}</div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {probe.rows.slice(hasHeader ? 1 : 0, (hasHeader ? 1 : 0) + 8).map((r, ri) => (
                    <tr key={ri}>
                      {Array.from({ length: width }, (_, i) => (
                        <td key={i} className="mono" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r[i] ?? ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
          {result ? <Summary result={result} tz={tz} /> : null}
        </>
      )}
    </Modal>
  );
}

function Summary({ result, tz }: { result: NewsImportResult; tz: string }): React.ReactElement {
  const s = result.summary;
  const [showRejected, setShowRejected] = useState(false);
  return (
    <Section title="Validation summary">
      <div className="stat-grid">
        <Stat2 k="Rows" v={formatInt(s.totalRows)} />
        <Stat2 k="Accepted" v={formatInt(s.accepted)} tone={s.accepted > 0 ? 'pos' : undefined} />
        <Stat2 k="Rejected" v={formatInt(s.rejected)} tone={s.rejected > 0 ? 'neg' : undefined} />
        <Stat2 k="Duplicates" v={formatInt(s.duplicates)} />
        <Stat2 k="Missing Actual" v={formatInt(s.missingActual)} />
        <Stat2 k="Missing Forecast" v={formatInt(s.missingForecast)} />
        <Stat2 k="Missing Previous" v={formatInt(s.missingPrevious)} />
        <Stat2 k="With Revised Previous" v={formatInt(s.withRevised)} />
        <Stat2 k="Unknown currency" v={formatInt(s.unknownCurrency)} />
        <Stat2 k="Unknown impact" v={formatInt(s.unknownImpact)} />
        <Stat2 k="Date format" v={s.dateFormat ?? '—'} />
        <Stat2 k="Range" v={s.firstTime !== null && s.lastTime !== null ? `${formatDate(s.firstTime, tz)} → ${formatDate(s.lastTime, tz)}` : '—'} />
      </div>
      <div className="row wrap" style={{ gap: 4, marginTop: 6 }}>
        {Object.entries(s.currencies)
          .sort((a, b) => b[1] - a[1])
          .map(([c, n]) => (
            <Chip key={c}>{c} · {formatInt(n)}</Chip>
          ))}
      </div>
      {s.rejected > 0 ? (
        <div style={{ marginTop: 8 }}>
          <Btn size="xs" onClick={() => setShowRejected((v) => !v)}>
            {showRejected ? 'Hide' : 'Show'} rejected rows ({formatInt(Math.min(s.rejectedRows.length, s.rejected))})
          </Btn>
          {showRejected ? (
            <div style={{ maxHeight: 160, overflow: 'auto', marginTop: 6 }}>
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Reason</th>
                    <th>Cells</th>
                  </tr>
                </thead>
                <tbody>
                  {s.rejectedRows.map((r, i) => (
                    <tr key={i}>
                      <td className="num">{r.row}</td>
                      <td>{r.reason}</td>
                      <td className="mono dim" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.cells.join(' | ').slice(0, 140)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
      {result.events.length > 0 ? (
        <div className="note small" style={{ marginTop: 6 }}>
          First event: {result.events[0].event} · {formatDateTime(result.events[0].time, tz)} ({tz})
        </div>
      ) : null}
    </Section>
  );
}

function Stat2({ k, v, tone }: { k: string; v: string; tone?: 'pos' | 'neg' }): React.ReactElement {
  return (
    <div className="stat">
      <div className="stat-k">{k}</div>
      <div className={`stat-v num ${tone ?? ''}`}>{v}</div>
    </div>
  );
}
