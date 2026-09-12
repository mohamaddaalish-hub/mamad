/** Application top bar: symbol/timeframe, chart type, view commands, modes. */

import { useState } from 'react';
import { Btn, Chip, Icon, Sel } from '../kit.tsx';
import { TIMEFRAMES, type TimeframeId } from '../../core/time/timeframes.ts';
import { CHART_MODES, PRESETS, PRESET_ORDER, type ChartMode, type ThemeName } from '../../core/chart/style.ts';
import {
  autoscale,
  fitAll,
  loadFixture,
  resetView,
  setTimeframe,
  setTimezone,
  updateChartSettings,
  zoomIn,
  zoomOut,
} from '../../core/app/actions.ts';
import { useApp, appStore } from '../../core/app/state.ts';
import { COMMON_TIMEZONES } from '../../core/time/tzList.ts';

export function Topbar(): React.ReactElement {
  const tf = useApp((s) => s.tf);
  const tz = useApp((s) => s.tz);
  const symbol = useApp((s) => s.symbol);
  const datasetId = useApp((s) => s.datasetId);
  const theme = useApp((s) => s.chart.theme);
  const mode = useApp((s) => s.chart.mode);
  const volume = useApp((s) => s.chart.showVolume);
  const grid = useApp((s) => s.chart.showGrid);
  const sessions = useApp((s) => s.chart.showSessionSeparators);
  const fullscreen = useApp((s) => s.fullscreen);
  const loading = useApp((s) => s.loading);
  const fixture = useApp((s) => s.fixtureMode);
  const [menu, setMenu] = useState(false);

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" />
        <div style={{ lineHeight: 1.05 }}>
          <div className="brand-name">ForexLab</div>
          <div className="brand-sub">historical research</div>
        </div>
      </div>

      <div className="group" style={{ minWidth: 0 }}>
        <Chip tone={datasetId ? 'accent' : undefined} title={datasetId ? 'active dataset' : 'no dataset loaded'}>
          <Icon name="chart" size={11} />
          {symbol}
          <span className="dim">·</span>
          {tf}
        </Chip>
        {fixture ? <Chip tone="warn">synthetic fixture</Chip> : null}
        {loading ? <Chip>{loading}</Chip> : null}
      </div>

      <div className="group" style={{ gap: 1 }}>
        {TIMEFRAMES.map((def) => (
          <Btn
            key={def.id}
            size="xs"
            active={tf === def.id}
            tip={`${def.label}${datasetId ? '' : ' — no dataset'}`}
            onClick={() => void setTimeframe(def.id as TimeframeId)}
          >
            {def.id}
          </Btn>
        ))}
      </div>

      <div className="group">
        <Btn icon="zoomOut" tip={`Zoom out (${''}−)`} onClick={zoomOut} />
        <Btn icon="zoomIn" tip="Zoom in (+)" onClick={zoomIn} />
        <Btn icon="fit" tip="Fit all bars" onClick={fitAll} />
        <Btn icon="target" tip="Auto price scale (double-click axis)" onClick={autoscale} />
        <Btn icon="restart" tip="Reset view" onClick={resetView} />
      </div>

      <div className="spacer" />

      <div className="group" style={{ position: 'relative' }}>
        <Btn icon={mode === 'candles' ? 'candles' : mode === 'bars' ? 'bars' : mode === 'area' ? 'area' : 'line'} tip="Chart type" onClick={() => setMenu((v) => !v)}>
          Type
        </Btn>
        {menu ? (
          <div
            className="panel"
            style={{
              position: 'absolute',
              top: 30,
              right: 0,
              width: 190,
              zIndex: 40,
              border: '1px solid var(--border)',
              borderRadius: 6,
              boxShadow: 'var(--shadow)',
              padding: 6,
            }}
            onMouseLeave={() => setMenu(false)}
          >
            <div style={{ display: 'grid', gap: 2 }}>
              {CHART_MODES.map((m) => (
                <Btn
                  key={m.id}
                  size="sm"
                  active={mode === m.id}
                  onClick={() => {
                    updateChartSettings({ mode: m.id as ChartMode });
                    setMenu(false);
                  }}
                  style={{ justifyContent: 'flex-start' }}
                >
                  {m.label}
                </Btn>
              ))}
            </div>
            <div className="divider" />
            <div style={{ display: 'grid', gap: 3 }}>
              <label className="check">
                <input type="checkbox" checked={volume} onChange={(e) => updateChartSettings({ showVolume: e.target.checked })} />
                Volume
              </label>
              <label className="check">
                <input type="checkbox" checked={grid} onChange={(e) => updateChartSettings({ showGrid: e.target.checked })} />
                Grid
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={sessions}
                  onChange={(e) => updateChartSettings({ showSessionSeparators: e.target.checked })}
                />
                Session separators
              </label>
            </div>
          </div>
        ) : null}
        <Sel
          className="select"
          value={tz}
          onChange={(v) => void setTimezone(v)}
          options={COMMON_TIMEZONES.map((z) => ({ value: z.id, label: z.short }))}
          ariaLabel="Chart timezone"
        />
        <Sel
          value={theme}
          onChange={(v) => updateChartSettings({ theme: v as ThemeName })}
          options={PRESET_ORDER.map((id) => ({ value: id, label: PRESETS[id].name }))}
          ariaLabel="Chart theme"
        />
        <Btn icon={fullscreen ? 'close' : 'expand'} tip="Fullscreen chart (F)" onClick={() => appStore.set({ fullscreen: !fullscreen })} />
        {!datasetId ? (
          <Btn icon="flask" tip="Load the deterministic synthetic fixture (verification only — not market data)" onClick={() => void loadFixture()}>
            Fixture
          </Btn>
        ) : null}
      </div>
    </header>
  );
}
