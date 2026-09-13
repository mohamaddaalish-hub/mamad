/** Bottom status strip: provenance, cursor readout, view metrics, storage. */

import { useEffect, useState } from 'react';
import { useApp } from '../../core/app/state.ts';
import { useView } from '../../core/app/viewState.ts';
import { chartHost, datasetBounds } from '../../core/app/actions.ts';
import { formatAxisDateTime } from '../../core/chart/axes.ts';
import { formatBytes, formatNumber, formatInt } from '../../core/util/format.ts';
import { estimateUsage } from '../../core/store/idb.ts';

export function StatusBar(): React.ReactElement {
  const symbol = useApp((s) => s.symbol);
  const tf = useApp((s) => s.tf);
  const tz = useApp((s) => s.tz);
  const decimals = useApp((s) => s.chart.priceDecimals);
  const replay = useApp((s) => s.replay);
  const diagnostics = useApp((s) => s.diagnostics);
  const fixture = useApp((s) => s.fixtureMode);
  const hover = useView((s) => s.hover);
  const pxPerBar = useView((s) => s.pxPerBar);
  const visibleBars = useView((s) => s.visibleBars);
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void estimateUsage().then((u) => {
        if (alive) setUsage(u);
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 8000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [replay.active, fixture]);

  const bounds = datasetBounds();
  const last = diagnostics[diagnostics.length - 1];

  return (
    <footer className="statusbar">
      <span className={fixture ? 'chip warn' : 'chip'} title={fixture ? 'Synthetic verification fixture — not market data' : 'Data comes from files you imported'}>
        {fixture ? 'synthetic fixture' : 'user data · local'}
      </span>
      <span className="sep" />
      <span>
        {symbol} · {tf} · {tz}
      </span>
      {hover && hover.index !== null ? (
        <>
          <span className="sep" />
          <span className="num">{hover.time !== null ? formatAxisDateTime(hover.time, tz, true) : ''}</span>
          {hover.candle ? (
            <span className="num">
              O {formatNumber(hover.candle.o, decimals)} H {formatNumber(hover.candle.h, decimals)} L{' '}
              {formatNumber(hover.candle.l, decimals)} C {formatNumber(hover.candle.c, decimals)}
            </span>
          ) : null}
        </>
      ) : null}
      <span className="sep" />
      <span className="num" title="bars currently on screen">
        {formatInt(visibleBars)} bars @ {pxPerBar.toFixed(2)}px
      </span>
      {replay.active ? (
        <>
          <span className="sep" />
          <span style={{ color: 'var(--warn)' }}>
            replay {formatInt(replay.cursor + 1)}/{formatInt(replay.total)} · {replay.speed}×
          </span>
        </>
      ) : null}
      <span className="spacer" style={{ flex: '1 1 auto' }} />
      {last ? (
        <span
          className={last.level === 'error' ? 'neg' : last.level === 'warn' ? 'dim' : 'dim'}
          title="Latest diagnostic — full log in Settings"
          style={{ maxWidth: 520, overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {last.text}
        </span>
      ) : null}
      {bounds ? (
        <span className="num dim" title="imported range">
          {formatAxisDateTime(bounds[0], tz, false)} → {formatAxisDateTime(bounds[1], tz, false)}
        </span>
      ) : null}
      {usage ? (
        <span className="num dim" title="IndexedDB usage (browser storage estimate)">
          {formatBytes(usage.usage)} / {formatBytes(usage.quota)}
        </span>
      ) : null}
      <span className="dim" title="This workstation never contacts a broker, feed or server">
        offline-capable
      </span>
      <span className="dim">{chartHost.engine ? 'chart ok' : 'chart init'}</span>
    </footer>
  );
}
