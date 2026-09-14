#!/usr/bin/env python3
"""
Build EURUSD_M1_2021.csv — full-year, 1-minute EUR/USD history for 2021.

Source
------
HistData.com "ASCII M1" export for EURUSD (file DAT_ASCII_EURUSD_M1_2021.csv),
obtained through a public GitHub mirror of the HistData dataset
(Dukascopy's datafeed is not reachable from this environment), and
cross-validated row-by-row against a second, independent mirror of the same
HistData export (DAT_MS_EURUSD_M1_2021.csv, Excel/CSV layout).

What this script does
---------------------
  1. parse      : strict parse of the source rows (no coercion, no guessing)
  2. validate   : timestamp / numeric / OHLC-relationship checks
  3. clean      : drop malformed rows, drop invalid candles, drop duplicate
                  timestamps, sort chronologically
  4. convert    : source wall-clock (EST/EDT, US-DST-dated switch) -> UTC
  5. gap audit  : classify every interval hole as normal market closure
                  (weekend / holiday) or abnormal (feed) gap
  6. export     : UTF-8, comma separated, header
                  timestamp,open,high,low,close,volume

Nothing is ever interpolated, filled, smoothed or synthesised.  Bars that are
absent from the source stay absent.
"""

from __future__ import annotations

import datetime as dt
import os
import sys

SOURCE = os.environ.get(
    'SRC', '/tmp/dl/DAT_ASCII_EURUSD_M1_2021.csv'
)
MIRROR = os.environ.get(
    'MIRROR', '/tmp/dl/DAT_MS_EURUSD_M1_2021.csv'
)
OUT_CSV = os.environ.get('OUT', '/home/user/mamad/EURUSD_M1_2021.csv')

YEAR = 2021

# --------------------------------------------------------------------------
# Timezone handling
# --------------------------------------------------------------------------
# The source stamps are *local* wall-clock on a UTC-5 clock that switches to
# UTC-4 during the European (not US) DST window.  Both switch instants fall
# inside a weekend market closure, so no bar is ambiguous.
#
# Empirical proof used (ET-anchored events, spike = largest 1-min move):
#   FOMC 2021-03-17 14:00 ET -> spike at 13:00 source time  => UTC-5
#   FOMC 2021-04-28 14:00 ET -> spike at 14:00 source time  => UTC-4
#   FOMC 2021-11-03 14:00 ET -> spike at 13:00 source time  => UTC-5
#   NFP  2021-11-05 08:30 ET -> spike at 07:30 source time  => UTC-5
# and the FX week open (17:00 New York) lands on 17:00 source time in winter,
# 16:00 during the two US/EU "shoulder" weeks, 17:00 in the EU-summer window.
DST_START_UTC = dt.datetime(2021, 3, 28, 1, 0)   # EU DST start, 2021-03-28 01:00 UTC
DST_END_UTC = dt.datetime(2021, 10, 31, 1, 0)    # EU DST end,   2021-10-31 01:00 UTC


def to_utc(local: dt.datetime) -> dt.datetime:
    """Convert a naive source wall-clock timestamp to UTC."""
    if DST_START_UTC <= local + dt.timedelta(hours=5) < DST_END_UTC:
        return local + dt.timedelta(hours=4)     # source on EDT-like offset
    return local + dt.timedelta(hours=5)         # source on EST-like offset


# --------------------------------------------------------------------------
# 1. parse
# --------------------------------------------------------------------------
def parse_source(path: str):
    """Yield (line_no, raw_line, parsed_tuple|None, error|None)."""
    with open(path, 'r', encoding='utf-8', errors='replace', newline='') as fh:
        for line_no, raw in enumerate(fh, 1):
            line = raw.rstrip('\r\n')
            if not line.strip():
                continue
            fields = line.split(';')
            if len(fields) != 6:
                yield line_no, line, None, 'field count != 6'
                continue
            ts, o, h, l, c, v = (f.strip() for f in fields)
            try:
                stamp = dt.datetime.strptime(ts, '%Y%m%d %H%M%S')
            except ValueError:
                yield line_no, line, None, 'unparsable timestamp'
                continue
            yield line_no, line, (stamp, o, h, l, c, v), None


# --------------------------------------------------------------------------
# 2/3. validate + clean
# --------------------------------------------------------------------------
NUMERIC = set('0123456789.')


def main() -> int:
    stats = {
        'lines_read': 0,
        'malformed': 0,
        'out_of_range_year': 0,
        'invalid_ohlc': 0,
        'duplicate_timestamps': 0,
        'kept': 0,
    }
    malformed_samples: list[tuple[int, str, str]] = []
    invalid_samples: list[tuple[int, str, str]] = []
    duplicate_samples: list[str] = []

    candles: dict[dt.datetime, tuple[str, str, str, str, str]] = {}

    for line_no, raw, parsed, err in parse_source(SOURCE):
        stats['lines_read'] += 1
        if err is not None:
            stats['malformed'] += 1
            if len(malformed_samples) < 20:
                malformed_samples.append((line_no, err, raw))
            continue

        stamp, o, h, l, c, v = parsed

        # --- numeric validation (prices keep their source precision) -------
        bad = None
        for name, cell in (('open', o), ('high', h), ('low', l), ('close', c), ('volume', v)):
            if not cell or any(ch not in NUMERIC for ch in cell):
                bad = f'non-numeric {name}: {cell!r}'
                break
        if bad is None:
            fo, fh, fl, fc = float(o), float(h), float(l), float(c)
            fv = float(v)
            if min(fo, fh, fl, fc) <= 0:
                bad = 'non-positive price'
            elif fv < 0 or fv != int(fv):
                bad = f'bad volume: {v!r}'
            elif fh < fl:
                bad = f'high < low ({h} < {l})'
            elif fh < max(fo, fc) or fl > min(fo, fc):
                bad = f'OHLC envelope violated (o={o} h={h} l={l} c={c})'
        if bad is not None:
            stats['invalid_ohlc'] += 1
            if len(invalid_samples) < 20:
                invalid_samples.append((line_no, bad, raw))
            continue

        # --- timestamp range ----------------------------------------------
        utc = to_utc(stamp)
        if utc.year != YEAR:
            # a 2021 local stamp can roll into 2022-01-01 UTC only inside the
            # final weekend closure; nothing else may fall outside the year.
            if not (utc.year == YEAR + 1 and utc < dt.datetime(2022, 1, 1, 6, 0)):
                stats['out_of_range_year'] += 1
                if len(malformed_samples) < 20:
                    malformed_samples.append((line_no, f'timestamp outside {YEAR}', raw))
                continue

        # --- duplicate timestamps (keep the first occurrence) --------------
        if utc in candles:
            stats['duplicate_timestamps'] += 1
            if len(duplicate_samples) < 20:
                duplicate_samples.append(raw)
            continue
        candles[utc] = (o, h, l, c, v)

    ordered = sorted(candles)
    stats['kept'] = len(ordered)

    # ----------------------------------------------------------------------
    # 5. gap audit
    # ----------------------------------------------------------------------
    # FX week is anchored to New York wall-clock: it opens Sunday 17:00 NY and
    # the last bar of the week starts Friday 16:59 NY.  In UTC that is
    # 21:00/20:59 while New York is on EDT and 22:00/21:59 while on EST.
    NY_DST_START = dt.datetime(2021, 3, 14, 7, 0)    # 02:00 EST -> 07:00 UTC
    NY_DST_END = dt.datetime(2021, 11, 7, 6, 0)      # 02:00 EDT -> 06:00 UTC

    def ny_is_dst(t: dt.datetime) -> bool:
        return NY_DST_START <= t < NY_DST_END

    def session_open(sunday: dt.date) -> dt.datetime:
        base = dt.datetime.combine(sunday, dt.time(21, 0))   # 17:00 EDT
        if not ny_is_dst(base):
            base += dt.timedelta(hours=1)                    # 17:00 EST = 22:00 UTC
        return base

    def session_close(sunday: dt.date) -> dt.datetime:
        friday = sunday + dt.timedelta(days=5)
        base = dt.datetime.combine(friday, dt.time(20, 59))  # 16:59 EDT
        if not ny_is_dst(base):
            base += dt.timedelta(hours=1)                    # 16:59 EST = 21:59 UTC
        return base

    def session_of(t: dt.datetime) -> dt.date:
        """Sunday date of the trading week that bar `t` belongs to."""
        sunday = t.date() - dt.timedelta(days=(t.weekday() + 1) % 7)
        if t < session_open(sunday):
            sunday -= dt.timedelta(days=7)
        return sunday

    weekends: list[dict] = []
    holidays: list[dict] = []
    abnormal: list[dict] = []
    inside_missing = 0

    HOLIDAY_DAYS = {
        dt.date(2021, 1, 1): "New Year's Day",
        dt.date(2021, 4, 2): 'Good Friday',
        dt.date(2021, 5, 3): 'UK Early May bank holiday',
        dt.date(2021, 5, 31): 'UK Spring bank holiday / US Memorial Day',
        dt.date(2021, 7, 5): 'US Independence Day (observed)',
        dt.date(2021, 12, 24): 'Christmas Eve (short session)',
        dt.date(2021, 12, 27): 'Boxing Day (observed)',
        dt.date(2021, 12, 28): 'Boxing Day (observed, some venues)',
        dt.date(2021, 12, 31): "New Year's Eve (short session)",
    }

    for a, b in zip(ordered, ordered[1:]):
        missing = int((b - a).total_seconds() // 60) - 1
        if missing <= 0:
            continue
        if session_of(a) != session_of(b):
            # Friday close -> Sunday open: a normal market closure
            weekends.append({'from': a, 'to': b, 'missing': missing,
                             'session': session_of(a)})
            continue
        hole_days = {(a + dt.timedelta(minutes=i)).date()
                     for i in range(0, missing + 1, 60)} | {a.date(), b.date()}
        named = [HOLIDAY_DAYS[d] for d in sorted(hole_days) if d in HOLIDAY_DAYS]
        if named and missing >= 60:
            holidays.append({'from': a, 'to': b, 'missing': missing, 'why': named[0]})
        else:
            abnormal.append({'from': a, 'to': b, 'missing': missing})
            inside_missing += missing

    # sanity: every bar must sit inside its session's open..close window
    outside_session = [t for t in ordered
                       if not (session_open(session_of(t)) <= t <= session_close(session_of(t)))]

    # ----------------------------------------------------------------------
    # 6. export
    # ----------------------------------------------------------------------
    with open(OUT_CSV, 'w', encoding='utf-8', newline='\n') as out:
        out.write('timestamp,open,high,low,close,volume\n')
        for t in ordered:
            o, h, l, c, v = candles[t]
            out.write(
                f'{t.strftime("%Y-%m-%dT%H:%M:%S")}+00:00,{o},{h},{l},{c},{int(float(v))}\n'
            )

    # ----------------------------------------------------------------------
    # mirror cross-check
    # ----------------------------------------------------------------------
    mirror_report = ''
    if os.path.exists(MIRROR):
        other: dict[dt.datetime, tuple] = {}
        with open(MIRROR, 'r', encoding='utf-8', errors='replace') as fh:
            for raw in fh:
                raw = raw.rstrip('\r\n')
                if not raw.strip():
                    continue
                f = raw.split(',')
                if len(f) != 7:
                    continue
                other[to_utc(dt.datetime.strptime(f[1], '%Y%m%d%H%M'))] = (
                    f[2], f[3], f[4], f[5], f[6])
        same_keys = set(other) == set(ordered)
        diffs = [k for k in ordered
                 if k in other and (
                     float(other[k][0]), float(other[k][1]),
                     float(other[k][2]), float(other[k][3]))
                 != (float(candles[k][0]), float(candles[k][1]),
                     float(candles[k][2]), float(candles[k][3]))]
        mirror_report = (
            f'mirror rows={len(other)} | identical timestamp set={same_keys} '
            f'| OHLC mismatches={len(diffs)}'
        )

    # ----------------------------------------------------------------------
    # report
    # ----------------------------------------------------------------------
    first, last = ordered[0], ordered[-1]
    lows = [float(candles[t][2]) for t in ordered]
    highs = [float(candles[t][1]) for t in ordered]

    print('=== BUILD ===')
    print(f'lines read            : {stats["lines_read"]}')
    print(f'malformed removed     : {stats["malformed"]}')
    print(f'invalid candles removed: {stats["invalid_ohlc"]}')
    print(f'duplicate ts removed  : {stats["duplicate_timestamps"]}')
    print(f'out-of-year removed   : {stats["out_of_range_year"]}')
    print(f'candles kept          : {stats["kept"]}')
    print(f'first (UTC)           : {first:%Y-%m-%dT%H:%M:%S}+00:00')
    print(f'last  (UTC)           : {last:%Y-%m-%dT%H:%M:%S}+00:00')
    print(f'min low / max high    : {min(lows):.5f} / {max(highs):.5f}')
    print(f'weekend closures      : {len(weekends)}')
    print(f'holiday closures      : {len(holidays)}')
    print(f'abnormal gaps         : {len(abnormal)} (missing bars {inside_missing})')
    print(f'bars outside session  : {len(outside_session)}')
    print(f'mirror cross-check    : {mirror_report}')
    print(f'output                : {OUT_CSV} ({os.path.getsize(OUT_CSV)} bytes)')

    if malformed_samples:
        print('\nmalformed samples:')
        for ln, err, raw in malformed_samples:
            print(f'  line {ln}: {err} :: {raw[:80]}')
    if invalid_samples:
        print('\ninvalid candle samples:')
        for ln, err, raw in invalid_samples:
            print(f'  line {ln}: {err} :: {raw[:80]}')
    if duplicate_samples:
        print('\nduplicate samples (first of each block):')
        for raw in duplicate_samples[:3]:
            print(f'  {raw}')

    print('\n=== ABNORMAL GAPS (top 25 by size) ===')
    for g in sorted(abnormal, key=lambda x: -x['missing'])[:25]:
        print(f"  {g['from']:%Y-%m-%d %H:%M}Z -> {g['to']:%Y-%m-%d %H:%M}Z  "
              f"missing={g['missing']} min")

    print('\n=== HOLIDAY / SHORT-SESSION CLOSURES ===')
    for g in holidays:
        print(f"  {g['from']:%Y-%m-%d %H:%M}Z -> {g['to']:%Y-%m-%d %H:%M}Z  "
              f"missing={g['missing']} min  ({g['why']})")

    print('\n=== WEEKEND CLOSURES (first 5) ===')
    for g in weekends[:5]:
        print(f"  {g['from']:%Y-%m-%d %H:%M}Z -> {g['to']:%Y-%m-%d %H:%M}Z  "
              f"missing={g['missing']} min")

    buckets = {'1-2 min': 0, '3-5 min': 0, '6-15 min': 0, '16-60 min': 0, '> 60 min': 0}
    for g in abnormal:
        m = g['missing']
        if m <= 2:
            buckets['1-2 min'] += 1
        elif m <= 5:
            buckets['3-5 min'] += 1
        elif m <= 15:
            buckets['6-15 min'] += 1
        elif m <= 60:
            buckets['16-60 min'] += 1
        else:
            buckets['> 60 min'] += 1
    print('\n=== ABNORMAL GAP SIZE BUCKETS ===')
    for k, v in buckets.items():
        print(f'  {k:>9}: {v}')

    # verify each session opens/closes where New York says it should
    sess: dict[dt.date, list] = {}
    for t in ordered:
        sess.setdefault(session_of(t), []).append(t)
    early, late = [], []
    for sunday, bars in sorted(sess.items()):
        bars.sort()
        exp_open, exp_close = session_open(sunday), session_close(sunday)
        if abs((bars[0] - exp_open).total_seconds()) > 45 * 60:
            early.append((sunday, bars[0], exp_open))
        if abs((bars[-1] - exp_close).total_seconds()) > 45 * 60:
            late.append((sunday, bars[-1], exp_close))
    print(f'\nsessions: {len(sess)}')
    print(f'  sessions whose first bar differs >45 min from the 17:00 NY open: {len(early)}')
    for sunday, got, exp in early:
        print(f'    week of {sunday}: first bar {got:%Y-%m-%d %H:%M}Z (expected ~{exp:%Y-%m-%d %H:%M}Z)')
    print(f'  sessions whose last bar differs >45 min from the 16:59 NY close: {len(late)}')
    for sunday, got, exp in late:
        print(f'    week of {sunday}: last bar {got:%Y-%m-%d %H:%M}Z (expected ~{exp:%Y-%m-%d %H:%M}Z)')

    # reconciliation: expected M1 slots inside the session windows
    expected = sum(int((session_close(s) - session_open(s)).total_seconds() // 60) + 1
                   for s in sess)
    trailing = int((session_close(session_of(ordered[-1])) - ordered[-1]).total_seconds() // 60)
    holiday_missing = sum(g['missing'] for g in holidays)
    edge = (expected - len(ordered)) - inside_missing - holiday_missing - trailing
    print('\n=== RECONCILIATION (M1 slots inside the 52 session windows) ===')
    print(f'  expected slots (52 sessions x 7200)     : {expected}')
    print(f'  present                                 : {len(ordered)} '
          f'({100*len(ordered)/expected:.3f}%)')
    print(f'  missing                                 : {expected - len(ordered)} '
          f'({100*(expected-len(ordered))/expected:.3f}%)')
    print(f'      - holiday closure (2021-05-31)      : {holiday_missing}')
    print(f'      - abnormal intra-session gaps       : {inside_missing}')
    print(f'      - weekly open/close edge minutes    : {edge}')
    print(f'      - year-end truncation (last bar)    : {trailing}')
    print(f'  weekend closures (outside all windows)  : {len(weekends)}')

    # thin-session days (informational only — nothing is removed)
    per_day: dict[dt.date, int] = {}
    for t in ordered:
        per_day[t.date()] = per_day.get(t.date(), 0) + 1
    print('\n=== THINNEST TRADING DAYS (informational, bars present) ===')
    for d, n in sorted(per_day.items(), key=lambda x: x[1])[:8]:
        print(f'  {d} ({d.strftime("%a")}): {n} bars'
              + (f'  <- {HOLIDAY_DAYS[d]}' if d in HOLIDAY_DAYS else ''))

    # monthly bar counts + per-day coverage for the report
    print('\n=== MONTHLY ===')
    per_month: dict[int, int] = {}
    for t in ordered:
        per_month[t.month] = per_month.get(t.month, 0) + 1
    for m in sorted(per_month):
        print(f'  {YEAR}-{m:02d}: {per_month[m]}')

    # days with zero bars inside Mon-Fri
    weekday_days: set[dt.date] = set()
    d = dt.date(YEAR, 1, 1)
    while d <= dt.date(YEAR, 12, 31):
        if d.weekday() < 5:
            weekday_days.add(d)
        d += dt.timedelta(days=1)
    present = {t.date() for t in ordered}
    empty = sorted(weekday_days - present)
    print('\nweekday (Mon-Fri) calendar days with NO bars at all:')
    for d in empty:
        print(f'  {d} ({d.strftime("%a")})'
              + (f'  <- {HOLIDAY_DAYS[d]}' if d in HOLIDAY_DAYS else ''))

    return 0


if __name__ == '__main__':
    sys.exit(main())
