/**
 * Go To Date. A calendar over the imported range: days that actually contain bars
 * are selectable, empty days are inert. Navigation always lands on a real bar —
 * missing data is never interpolated to make a jump "work".
 */

import { useMemo, useState } from 'react';
import { Btn, Modal } from '../kit.tsx';
import { useApp } from '../../core/app/state.ts';
import { chartHost, goToDateTime, goToTimestamp, jumpToFirst, jumpToLast } from '../../core/app/actions.ts';
import { formatDate, zonedInstant, zonedParts } from '../../core/time/tz.ts';
import { monthDays } from '../../core/time/calendar.ts';
import { cx } from '../../core/util/format.ts';

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

export function GoToDateDialog({ onClose }: { onClose: () => void }): React.ReactElement {
  const tz = useApp((s) => s.tz);
  const datasetEpoch = useApp((s) => s.datasetEpoch);
  const replay = useApp((s) => s.replay);
  const series = chartHost.engine?.getSeries() ?? null;
  const viewIndex = chartHost.engine?.view.rightIndex ?? 0;
  const start = series && series.count > 0 ? series.time(Math.max(0, Math.min(series.count - 1, Math.floor(viewIndex)))) : Date.now();
  const [monthAnchor, setMonthAnchor] = useState(() => {
    const p = zonedParts(start, tz);
    return { y: p.year, m: p.month };
  });
  const [clock, setClock] = useState(() => {
    const p = zonedParts(start, tz);
    return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  });
  const [text, setText] = useState(() => formatDate(start, tz));

  // Bars per calendar day, via binary search — never per-row timezone conversion.
  const days = useMemo(() => {
    if (!series || series.count === 0) return [];
    const limit = replay.active ? Math.min(series.count, replay.cursor + 1) : series.count;
    return monthDays(series.cols, limit, monthAnchor.y, monthAnchor.m, tz);
  }, [series, monthAnchor.y, monthAnchor.m, tz, replay, datasetEpoch]);;

  const shift = (delta: number): void => {
    setMonthAnchor(({ y, m }) => {
      const next = m - 1 + delta;
      return { y: y + Math.floor(next / 12), m: (next % 12 + 12) % 12 + 1 };
    });
  };

  const jump = (instant: number): void => {
    const [h, mi] = clock.split(':').map((v) => Number(v) || 0);
    const p = zonedParts(instant, tz);
    const target = zonedInstant(p.year, p.month, p.day, Math.min(23, h), Math.min(59, mi), 0, tz);
    if (goToTimestamp(target, 'right')) onClose();
  };

  const monthLabel = `${monthAnchor.y}-${String(monthAnchor.m).padStart(2, '0')}`;

  return (
    <Modal
      title="Go to date"
      subtitle={series && series.count > 0 ? `${formatDate(series.time(0), tz)} → ${formatDate(series.time(series.count - 1), tz)} · ${tz}` : 'no dataset loaded'}
      onClose={onClose}
      narrow
      footer={
        <>
          <Btn size="xs" onClick={jumpToFirst} tip="First bar of the dataset (Home)">
            First
          </Btn>
          <Btn size="xs" onClick={jumpToLast} tip="Newest bar (End)">
            Last
          </Btn>
          <span style={{ flex: '1 1 auto' }} />
          <input
            className="input mono"
            style={{ width: 72 }}
            value={clock}
            onChange={(e) => setClock(e.target.value)}
            aria-label="Time of day in chart timezone"
            title="Time of day, chart timezone"
            placeholder="HH:MM"
          />
          <Btn
            variant="primary"
            size="xs"
            onClick={() => {
              if (!goToDateTime(text)) setText(formatDate(chartHost.engine!.getSeries()!.time(Math.floor(chartHost.engine!.view.rightIndex)), tz));
              else onClose();
            }}
            tip="Accept the typed date (Enter) — YYYY-MM-DD[ HH:mm]"
          >
            Go
          </Btn>
        </>
      }
    >
      <div className="row" style={{ gap: 6, marginBottom: 8 }}>
        <input
          className="input mono"
          style={{ flex: '1 1 auto' }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && goToDateTime(text)) onClose();
          }}
          placeholder="2024-03-15 16:00"
          aria-label="Date and time"
        />
        <Btn size="xs" onClick={() => shift(-1)} tip="Previous month">
          ‹
        </Btn>
        <span className="mono" style={{ minWidth: 68, textAlign: 'center', fontSize: 12 }}>
          {monthLabel}
        </span>
        <Btn size="xs" onClick={() => shift(1)} tip="Next month">
          ›
        </Btn>
      </div>

      {series && series.count > 0 ? (
        <>
          <div className="cal-grid">
            {WEEKDAYS.map((w) => (
              <div key={w} className="cal-head dim">
                {w}
              </div>
            ))}
            {days.map((c, i) =>
              c.outside ? (
                <div key={`b${i}`} className="cal-cell blank" />
              ) : (
                <button
                  key={c.day}
                  type="button"
                  className={cx('cal-cell', c.bars > 0 && 'has-data')}
                  disabled={c.bars === 0}
                  title={c.bars > 0 ? `${c.bars.toLocaleString()} bars · ${formatDate(c.start, tz)}` : 'No imported data for this day'}
                  onClick={() => jump(c.start)}
                >
                  <span>{c.day}</span>
                  {c.bars > 0 ? <i /> : null}
                </button>
              ),
            )}
          </div>
          <div className="note small dim" style={{ marginTop: 8 }}>
            Days without a dot contain no imported bars. A jump lands on the last bar at or before the requested
            moment; empty periods are never filled in.
          </div>
        </>
      ) : (
        <div className="notice">Import a CSV to enable date navigation.</div>
      )}
    </Modal>
  );
}
