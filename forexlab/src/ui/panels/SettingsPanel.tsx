/** Settings: appearance, chart behaviour, data residency, diagnostics. */

import { useEffect, useState } from 'react';
import { Btn, Field, Section, Sel, Slider, Switch } from '../kit.tsx';
import { PRESETS, PRESET_ORDER, type ThemeName } from '../../core/chart/style.ts';
import { clearDiagnostics, pushDiagnostic, useApp } from '../../core/app/state.ts';
import { chartHost, updateChartSettings } from '../../core/app/actions.ts';
import { datasetRegistry } from '../../core/data/datasets.ts';
import { estimateUsage, openDb } from '../../core/store/idb.ts';
import { formatBytes, formatInt } from '../../core/util/format.ts';
import { TIMEZONE_OPTIONS, localTimeZone } from '../../core/time/tzList.ts';
import { setTimezone } from '../../core/app/actions.ts';

const COLOR_FIELDS: { key: 'background' | 'gridColor' | 'bull' | 'bear' | 'wickBull' | 'wickBear' | 'textColor' | 'crosshair' | 'axisBg'; label: string }[] = [
  { key: 'background', label: 'Background' },
  { key: 'gridColor', label: 'Grid' },
  { key: 'textColor', label: 'Text' },
  { key: 'crosshair', label: 'Crosshair' },
  { key: 'bull', label: 'Bull candle' },
  { key: 'bear', label: 'Bear candle' },
  { key: 'wickBull', label: 'Bull wick' },
  { key: 'wickBear', label: 'Bear wick' },
  { key: 'axisBg', label: 'Scale background' },
];

export function SettingsPanel(): React.ReactElement {
  const settings = useApp((s) => s.chart);
  const tz = useApp((s) => s.tz);
  const diagnostics = useApp((s) => s.diagnostics);
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);

  useEffect(() => {
    void estimateUsage().then(setUsage);
  }, [diagnostics.length]);

  const preset = PRESETS[settings.theme];
  const colorOf = (key: string): string => {
    const value = (settings.overrides as Record<string, unknown>)[key] ?? (preset as unknown as Record<string, string>)[key];
    return typeof value === 'string' ? value : '#000000';
  };

  return (
    <div className="panel-body">
      <Section title="Appearance preset">
        <div className="grid2">
          {PRESET_ORDER.map((id) => {
            const p = PRESETS[id];
            return (
              <Btn
                key={id}
                className="ghost"
                active={settings.theme === id}
                style={{ justifyContent: 'flex-start', gap: 6, height: 28 }}
                onClick={() => updateChartSettings({ theme: id as ThemeName })}
              >
                <span
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 2,
                    background: p.background,
                    border: `1px solid ${p.gridColor}`,
                    display: 'inline-block',
                  }}
                />
                {p.name}
              </Btn>
            );
          })}
        </div>
      </Section>

      <Section
        title="Custom colours"
        right={
          <Btn
            size="xs"
            tip="Remove all colour overrides and follow the preset"
            onClick={() => updateChartSettings({ overrides: {} })}
          >
            reset
          </Btn>
        }
      >
        <div className="grid2">
          {COLOR_FIELDS.map((f) => (
            <div className="row" key={f.key} style={{ gap: 6 }}>
              <input
                type="color"
                value={ensureHex(colorOf(f.key))}
                onChange={(e) =>
                  updateChartSettings({ overrides: { ...settings.overrides, [f.key]: e.target.value } })
                }
              />
              <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{f.label}</span>
            </div>
          ))}
        </div>
        <div style={{ height: 8 }} />
        <Slider
          label="Grid opacity"
          min={0}
          max={1}
          step={0.05}
          value={settings.overrides.gridOpacity ?? preset.gridOpacity}
          format={(v) => v.toFixed(2)}
          onChange={(v) => updateChartSettings({ overrides: { ...settings.overrides, gridOpacity: v } })}
        />
        <div style={{ height: 6 }} />
        <div className="grid2">
          <Switch label="Outline candles" checked={settings.outlineCandles} onChange={(v) => updateChartSettings({ outlineCandles: v })} />
          <Switch label="Grid" checked={settings.showGrid} onChange={(v) => updateChartSettings({ showGrid: v })} />
          <Switch label="Volume" checked={settings.showVolume} onChange={(v) => updateChartSettings({ showVolume: v })} />
          <Switch
            label="Session separators"
            checked={settings.showSessionSeparators}
            onChange={(v) => updateChartSettings({ showSessionSeparators: v })}
          />
          <Switch
            label="Crosshair labels"
            checked={settings.showCrosshairLabels}
            onChange={(v) => updateChartSettings({ showCrosshairLabels: v })}
          />
        </div>
        <div style={{ height: 8 }} />
        <Field label="Price decimals" hint="5 for most FX pairs, 3 for JPY">
          <Sel
            value={String(settings.priceDecimals)}
            onChange={(v) => updateChartSettings({ priceDecimals: Number(v) })}
            options={[3, 4, 5, 6, 7, 8].map((n) => ({ value: String(n), label: `${n} decimals` }))}
          />
        </Field>
      </Section>

      <Section title="Chart timezone">
        <p className="note small" style={{ marginTop: 0 }}>
          Re-buckets 1D/1W/1M candles and session separators. Intraday buckets are unaffected except where a zone has
          a non-hour offset.
        </p>
        <Sel
          value={tz}
          onChange={(v) => void setTimezone(v)}
          options={[...TIMEZONE_OPTIONS, ...(TIMEZONE_OPTIONS.some((o) => o.value === localTimeZone()) ? [] : [{ value: localTimeZone(), label: `Local · ${localTimeZone()}` }])]}
        />
      </Section>

      <Section title="Data residency">
        <p className="note small" style={{ marginTop: 0 }}>
          Everything stays in this browser (IndexedDB). No dataset is uploaded, and no server is contacted for quotes.
          Deleting a dataset here never touches your CSV files.
        </p>
        <div className="grid2">
          <Stat label="Datasets" value={formatInt(datasetRegistry.list().length)} />
          <Stat label="In memory" value={formatBytes(datasetRegistry.inMemoryBytes())} />
          <Stat label="Browser storage" value={usage ? formatBytes(usage.usage) : '—'} />
          <Stat label="Quota" value={usage ? formatBytes(usage.quota) : '—'} />
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <Btn
            size="sm"
            onClick={() => {
              datasetRegistry.debugClearMemory();
              chartHost.engine?.requestRender();
              pushDiagnostic('info', 'Released cached series from memory (data stays in IndexedDB)');
            }}
          >
            Release memory cache
          </Btn>
          <Btn
            size="sm"
            variant="danger"
            tip="Removes every imported dataset, drawing, session and news file from this browser"
            onClick={() => {
              if (!window.confirm('Erase all locally stored ForexLab data? Your source CSVs are not affected.')) return;
              void (async () => {
                const db = await openDb();
                for (const name of ['datasets', 'news', 'blobs', 'sessions', 'kv'] as const) {
                  const t = db.transaction(name, 'readwrite');
                  t.objectStore(name).clear();
                }
                pushDiagnostic('warn', 'Local storage erased — reload to start clean');
              })();
            }}
          >
            Erase local library
          </Btn>
        </div>
      </Section>

      <Section
        title={`Diagnostics (${formatInt(diagnostics.length)})`}
        right={<Btn size="xs" onClick={clearDiagnostics} tip="Clear the log">clear</Btn>}
      >
        {diagnostics.length === 0 ? (
          <div className="note small dim">Nothing logged.</div>
        ) : (
          <div style={{ display: 'grid', gap: 3, maxHeight: 200, overflow: 'auto' }}>
            {[...diagnostics].reverse().map((d) => (
              <div key={d.id} className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
                <span
                  className="num"
                  style={{ color: d.level === 'error' ? 'var(--danger)' : d.level === 'warn' ? 'var(--warn)' : 'var(--muted)', fontSize: 10 }}
                >
                  {new Date(d.at).toLocaleTimeString()}
                </span>
                <span className="note small" style={{ flex: '1 1 auto' }}>
                  {d.text}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Keyboard">
        <div style={{ display: 'grid', gap: 2 }}>
          {[
            ['Space', 'Play / pause replay'],
            ['→', 'Next candle'],
            ['Shift + →', 'Larger step'],
            ['R', 'Restart replay'],
            ['Esc', 'Exit replay / cancel tool'],
            ['G', 'Go to date'],
            ['F', 'Fullscreen chart'],
            ['+ / −', 'Zoom in / out'],
            ['Ctrl/Cmd + Z', 'Undo'],
            ['Ctrl/Cmd + Shift + Z', 'Redo'],
          ].map(([k, v]) => (
            <div className="row between" key={k}>
              <span className="note small">{v}</span>
              <span className="kbd">{k}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="row between" style={{ borderBottom: '1px solid var(--border-soft)', paddingBottom: 2 }}>
      <span className="dim" style={{ fontSize: 11 }}>{label}</span>
      <span className="num" style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}

function ensureHex(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  const m = /^#([0-9a-f]{3})$/i.exec(color);
  if (m) return `#${m[1].split('').map((c) => c + c).join('')}`;
  const rgb = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(color);
  if (rgb) return `#${[1, 2, 3].map((i) => Number(rgb[i]).toString(16).padStart(2, '0')).join('')}`;
  return '#000000';
}
