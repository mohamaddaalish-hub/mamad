/**
 * Bar Replay panel: choose the start bar, arm it, and see the integrity contract
 * while it runs. Everything here is about *when knowledge starts*, not about
 * hiding pixels.
 */

import { useState } from 'react';
import { Btn, Chip, Section, Stat } from '../kit.tsx';
import { barReplay, BARS_PER_SECOND_AT_1X, replayProgress, timeAt } from '../../core/replay/engine.ts';
import { hiddenBarCount } from '../../core/replay/gate.ts';
import { chartHost } from '../../core/chart/host.ts';
import { REPLAY_SPEEDS, useApp } from '../../core/app/state.ts';
import { viewStore } from '../../core/app/viewState.ts';
import { formatDate, formatDateTime, zonedToInstant } from '../../core/time/tz.ts';
import { formatInt } from '../../core/util/format.ts';
import { pushDiagnostic } from '../../core/app/state.ts';


export function ReplayPanel(): React.ReactElement {
  const replay = useApp((s) => s.replay);
  const tz = useApp((s) => s.tz);
  const datasetId = useApp((s) => s.datasetId);
  const [text, setText] = useState('');
  const series = chartHost.engine?.getBaseSeries() ?? null;
  const progress = Math.round(replayProgress() * 100);
  const startAt = replay.active ? replay.cursor : barReplay.startIndex;
  const hidden = hiddenBarCount();

  const armFromText = (): void => {
    if (!series) return;
    const instant = zonedToInstant(text, tz);
    if (instant === null) {
      pushDiagnostic('error', `Could not read "${text}" — expected YYYY-MM-DD[ HH:mm]`);
      return;
    }
    const i = series.indexAtOrBefore(instant);
    if (i < 0) {
      pushDiagnostic('warn', `${text} is before the first imported bar`);
      return;
    }
    if (series.time(i) !== instant) {
      pushDiagnostic('info', `No bar exactly at ${text}; arming at ${formatDateTime(series.time(i), tz)} instead`);
    }
    barReplay.setStartIndex(i);
  };

  return (
    <div className="panel-body">
      <Section title="Start point" right={startAt !== null ? <Chip>{formatDate(timeAt(startAt) ?? 0, tz)}</Chip> : <Chip tone="warn">not chosen</Chip>}>
        <div className="row" style={{ gap: 4, marginBottom: 6 }}>
          <input
            className="input mono"
            placeholder={`${formatDate(series?.time(0) ?? Date.now(), tz)} 00:00`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && armFromText()}
            disabled={!series}
          />
          <Btn size="xs" onClick={armFromText} disabled={!series || text.trim() === ''}>
            Arm
          </Btn>
        </div>
        <div className="row wrap" style={{ gap: 4 }}>
          <Btn
            size="xs"
            tip="Use the bar currently at the right edge of the chart"
            onClick={() => {
              const engine = chartHost.engine;
              if (!engine || !series) return;
              const i = Math.max(0, Math.min(series.count - 1, Math.round(engine.view.rightIndex)));
              barReplay.setStartIndex(i);
              setText(formatDateTime(series.time(i), tz));
            }}
            disabled={!series}
          >
            Use right-edge bar
          </Btn>
          <Btn
            size="xs"
            tip="Arm at the bar under the crosshair"
            onClick={() => {
              const i = viewStore.get().hover?.index ?? null;
              if (i === null) pushDiagnostic('info', 'Move the pointer over the chart first');
              else barReplay.setStartIndex(i);
            }}
            disabled={!series}
          >
            Use crosshair bar
          </Btn>
          <Btn
            size="xs"
            tip="Back to the first bar of the dataset"
            onClick={() => barReplay.setStartIndex(0)}
            disabled={!series}
          >
            First bar
          </Btn>
        </div>
      </Section>

      <Section title="Transport">
        <div className="row wrap" style={{ gap: 4, marginBottom: 8 }}>
          <Btn
            size="sm"
            variant="primary"
            icon="play"
            tip="Start replay at the armed bar"
            disabled={!series || series.count === 0}
            onClick={() => barReplay.start(barReplay.startIndex ?? undefined, { play: true })}
          >
            {replay.active ? 'Restart here' : 'Start replay'}
          </Btn>
          <Btn size="sm" icon={replay.playing ? 'pause' : 'play'} tip="Play / pause (Space)" onClick={() => barReplay.playPause()} disabled={!replay.active}>
            {replay.playing ? 'Pause' : 'Play'}
          </Btn>
          <Btn size="sm" icon="step" tip="One bar forward (→)" onClick={() => barReplay.step(1)} disabled={!replay.active}>
            Step
          </Btn>
          <Btn size="sm" icon="restart" tip="Back to the armed start bar (R)" onClick={() => barReplay.restart()} disabled={!replay.active}>
            Restart
          </Btn>
          <Btn size="sm" icon="close" tip="Exit replay (Esc)" onClick={() => barReplay.stop()} disabled={!replay.active}>
            Exit
          </Btn>
        </div>
        <div className="row wrap" style={{ gap: 2 }}>
          {REPLAY_SPEEDS.map((s) => (
            <Btn key={s} size="xs" active={replay.speed === s} tip={`${(BARS_PER_SECOND_AT_1X * s).toFixed(s < 1 ? 1 : 0)} bars/second`} onClick={() => barReplay.setSpeed(s)}>
              {s}×
            </Btn>
          ))}
        </div>
      </Section>

      {replay.active ? (
        <Section title="Integrity">
          <div className="stat-grid">
            <Stat label="revealed" value={`${progress}%`} tone="pos" hint={`${formatInt(replay.cursor + 1)} of ${formatInt(replay.total)} bars`} />
            <Stat label="hidden" value={formatInt(hidden)} tone={hidden > 0 ? 'neg' : 'pos'} hint="unreachable, not merely off-screen" />
            <Stat label="at bar" value={formatDateTime(timeAt(replay.cursor) ?? 0, tz)} hint="last known moment" />
            <Stat label="fingerprint" value={barReplay.checksum().slice(-8)} hint="deterministic: same steps → same hash" />
          </div>
          <div className="note small dim" style={{ marginTop: 6 }}>
            {datasetId ? 'Data, drawings, trades and news are read through the replay gate: bars after the cursor do not exist for them. ' : ''}
            Speed and frame rate change delivery timing only, never which bars are revealed.
          </div>
        </Section>
      ) : (
        <Section title="Rules">
          <ul className="rules">
            <li>Future bars are removed from the data the chart and every analysis module can read.</li>
            <li>Drawings anchored beyond the cursor stay hidden; price levels span all time and remain.</li>
            <li>News released after the cursor is unavailable — table, markers, statistics and backtests included.</li>
            <li>Trade calculations use only bars between entry and the cursor, never beyond it.</li>
            <li>Exit at any moment to return to the full dataset at the same time position.</li>
          </ul>
        </Section>
      )}
    </div>
  );
}
