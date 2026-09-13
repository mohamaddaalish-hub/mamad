/**
 * Replay transport, docked at the bottom of the chart. Shows exactly how many
 * bars are hidden, so "future data is not available" is visible, not implied.
 */

import { Btn, Chip, Icon, Sel } from '../kit.tsx';
import { barReplay, BARS_PER_SECOND_AT_1X } from '../../core/replay/engine.ts';
import { useApp, REPLAY_SPEEDS } from '../../core/app/state.ts';
import { chartHost } from '../../core/chart/host.ts';
import { formatDateTime } from '../../core/time/tz.ts';
import { formatInt } from '../../core/util/format.ts';

export function ReplayBar(): React.ReactElement | null {
  const replay = useApp((s) => s.replay);
  const tz = useApp((s) => s.tz);
  if (!replay.active) return null;
  const hidden = Math.max(0, replay.total - replay.cursor - 1);
  const atEdge = replay.cursor >= replay.total - 1;
  const speedOptions = REPLAY_SPEEDS.map((s) => ({
    value: s,
    label: `${s}×`,
    title: `${(BARS_PER_SECOND_AT_1X * s).toFixed(s < 1 ? 1 : 0)} bars/second`,
  }));

  return (
    <div className="replay-bar" onPointerDown={(e) => e.stopPropagation()}>
      <span className="replay-flag">
        <Icon name="play" size={9} /> BAR REPLAY
      </span>
      <div className="row" style={{ gap: 1 }}>
        <Btn
          size="xs"
          icon="restart"
          tip="Restart at the chosen start bar (R)"
          onClick={() => barReplay.restart()}
        />
        <Btn
          size="xs"
          icon="stepBack"
          tip="One bar back (←), Shift for ten"
          onClick={() => barReplay.step(-1)}
        />
        <Btn
          size="xs"
          variant={replay.playing ? 'primary' : 'default'}
          icon={replay.playing ? 'pause' : 'play'}
          tip={replay.playing ? 'Pause (Space)' : 'Play (Space)'}
          onClick={() => barReplay.playPause()}
          disabled={atEdge && !replay.playing}
        />
        <Btn size="xs" icon="step" tip="Next bar (→), Shift for ten" onClick={() => barReplay.step(1)} disabled={atEdge} />
      </div>
      <Sel
        className="select tiny"
        value={replay.speed}
        onChange={(v) => barReplay.setSpeed(Number(v))}
        options={speedOptions}
        ariaLabel="Replay speed"
      />
      <span className="replay-clock mono" title="Current replay bar">
        #{formatInt(replay.cursor + 1)} / {formatInt(replay.total)}
        {`  ${formatDateTime(barTime(replay.cursor), tz)}`}
      </span>
      <div className="replay-track" role="presentation">
        <div
          className="replay-fill"
          style={{ width: `${replay.total > 1 ? (replay.cursor / (replay.total - 1)) * 100 : 100}%` }}
        />
      </div>
      <Chip tone={hidden > 0 ? 'warn' : 'bull'} title="Bars the replay has not revealed yet">
        {formatInt(hidden)} hidden
      </Chip>
      <label className="check tiny">
        <input
          type="checkbox"
          checked={replay.follow}
          onChange={(e) => barReplay.setFollow(e.target.checked)}
          title="Keep the revealed bar at the right edge"
        />
        follow
      </label>
      <Btn size="xs" tip="Exit replay and show the whole dataset (Esc)" onClick={() => barReplay.stop()}>
        Exit
      </Btn>
    </div>
  );
}

function barTime(cursor: number): number {
  const series = chartHost.engine?.getBaseSeries() ?? chartHost.engine?.getSeries();
  if (!series || series.count === 0) return Date.now();
  return series.time(Math.max(0, Math.min(series.count - 1, cursor)));
}
