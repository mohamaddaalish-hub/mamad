/**
 * Chart navigation strip: the view position readout plus first / prev / goto /
 * next / last controls. It reflects the *replay-limited* range while a replay is
 * running, so the numbers never describe bars the user cannot see.
 */

import { Btn, Chip } from '../kit.tsx';
import { openDialog } from '../../core/app/dialogs.ts';
import { chartHost, jumpToFirst, jumpToLast, stepPeriod } from '../../core/app/actions.ts';
import { useApp } from '../../core/app/state.ts';
import { barReplay } from '../../core/replay/engine.ts';
import { useView } from '../../core/app/viewState.ts';
import { formatDateTime, formatTime } from '../../core/time/tz.ts';

export function ChartNav(): React.ReactElement {
  const tz = useApp((s) => s.tz);
  const symbol = useApp((s) => s.symbol);
  const tf = useApp((s) => s.tf);
  const datasetId = useApp((s) => s.datasetId);
  const replay = useApp((s) => s.replay);
  const rightIndex = useView((s) => s.rightIndex);
  const hover = useView((s) => s.hover);
  const series = chartHost.engine?.getSeries() ?? null;
  const count = series ? (replay.active ? Math.min(series.count, replay.cursor + 1) : series.count) : 0;
  const at = (i: number): number | null => (series && i >= 0 && i < count ? series.time(Math.round(i)) : null);
  const hoverTime = hover?.time ?? null;
  const edgeTime = at(Math.min(Math.round(rightIndex), count - 1));
  const shown = hoverTime ?? edgeTime;
  const progress = count > 0 ? Math.round(((Math.min(rightIndex, count - 1) + 1) / count) * 100) : 0;

  return (
    <div className="chart-nav">
      <span className="nav-sym mono">
        {symbol}
        <span className="dim"> · {tf}</span>
      </span>
      <span className="nav-clock mono" title={datasetId ? 'Bar at the right edge (crosshair time while hovering)' : 'no dataset'}>
        {shown === null ? '—' : `${formatDateTime(shown, tz)}${formatTime(shown, tz) ? '' : ''}`}
      </span>
      <div className="row" style={{ gap: 1 }}>
        <Btn size="xs" onClick={jumpToFirst} disabled={count === 0} tip="First bar (Shift + Home)">
          «
        </Btn>
        <Btn size="xs" onClick={() => stepPeriod(-1)} disabled={count === 0} tip="Previous period (← when replay is idle)">
          ‹
        </Btn>
        <Btn size="xs" onClick={() => openDialog('goto')} disabled={count === 0} tip="Go to date and time (G)">
          Go to
        </Btn>
        <Btn size="xs" onClick={() => stepPeriod(1)} disabled={count === 0} tip="Next period (→ when replay is idle)">
          ›
        </Btn>
        <Btn size="xs" onClick={jumpToLast} disabled={count === 0} tip="Newest bar (End)">
          »
        </Btn>
      </div>
      {count > 0 ? (
        <Chip title={`${Math.min(Math.round(rightIndex) + 1, count).toLocaleString()} of ${count.toLocaleString()} bars`}>
          {progress}%
        </Chip>
      ) : null}
      <Btn
        size="xs"
        icon={replay.active ? 'close' : 'play'}
        active={replay.active}
        variant={replay.active ? 'primary' : 'default'}
        disabled={count === 0}
        tip={
          replay.active
            ? 'Exit replay (Esc) — the hidden bars become visible again'
            : 'Replay from the bar at the right edge — later bars stay unavailable to the chart, drawings, trades and news'
        }
        onClick={() => barReplay.toggle()}
      >
        {replay.active ? `replay ${Math.min(replay.cursor + 1, replay.total || replay.cursor + 1)}/${replay.total || count}` : 'Replay'}
      </Btn>
    </div>
  );
}
