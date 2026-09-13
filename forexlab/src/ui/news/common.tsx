/** Shared presentational helpers for the news/research UI. */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../../core/util/format.ts';
import { formatPips } from '../../core/util/pips.ts';
import { IMPACT_LABEL, SESSION_LABEL, type Impact, type Maybe, type Session, isOk } from '../../core/econ/types.ts';

export function MaybeNum({ v, decimals = 1, suffix = '', signed = false, tone = true, title }: { v: Maybe<number> | null | undefined; decimals?: number; suffix?: string; signed?: boolean; tone?: boolean; title?: string }): React.ReactElement {
  if (!v || v.status !== 'ok') return <span className="dim unavailable" title={v && v.status === 'unavailable' ? v.reason : 'unavailable'}>—</span>;
  const x = v.value;
  const text = signed ? `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(decimals)}${suffix}` : `${x.toFixed(decimals)}${suffix}`;
  return <span className={cx('num', tone && x > 0 && 'pos', tone && x < 0 && 'neg')} title={title}>{text}</span>;
}

export function Pips({ v, decimals = 1 }: { v: Maybe<number> | number | null | undefined; decimals?: number }): React.ReactElement {
  const m: Maybe<number> | null = typeof v === 'number' ? { status: 'ok', value: v } : v ?? null;
  if (!m || !isOk(m)) return <span className="dim" title={m && m.status === 'unavailable' ? m.reason : 'unavailable'}>—</span>;
  return <span className={cx('num', m.value > 0 && 'pos', m.value < 0 && 'neg')}>{formatPips(m.value, decimals)}</span>;
}

export function num(x: number | null | undefined, d = 1, signed = false): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  if (x === Number.POSITIVE_INFINITY) return '∞';
  return signed ? `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}` : x.toFixed(d);
}

export function pct(x: number | null | undefined, d = 0): string {
  return x === null || x === undefined || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`;
}

export function ImpactDot({ impact }: { impact: Impact | null }): React.ReactElement {
  const cls = impact ?? 'unknown';
  return <span className={cx('impact-dot', `impact-${cls}`)} title={impact ? IMPACT_LABEL[impact] : 'unknown impact'} />;
}

export function SessionTag({ s }: { s: Session }): React.ReactElement {
  return <span className="tag">{SESSION_LABEL[s]}</span>;
}

export function Warn({ children }: { children: ReactNode }): React.ReactElement {
  return <div className="notice warn small">{children}</div>;
}

export function LowSample({ n, min = 10 }: { n: number; min?: number }): React.ReactElement | null {
  if (n >= min) return null;
  return <span className="chip warn" title={`Only ${n} observations — treat as anecdotal`}>low sample · n={n}</span>;
}

/* ------------------------------------------------------------- virtual list */

/**
 * Fixed-row-height windowed list. Renders only rows intersecting the viewport
 * (+overscan), so tens of thousands of events cost a few dozen DOM rows.
 */
export function VirtualList<T>({
  items,
  rowHeight,
  render,
  header,
  overscan = 8,
  className,
  emptyText = 'Nothing to show',
  height,
}: {
  items: readonly T[];
  rowHeight: number;
  render: (item: T, index: number) => ReactNode;
  header?: ReactNode;
  overscan?: number;
  className?: string;
  emptyText?: string;
  height?: number | string;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ from: 0, to: 40 });
  const [viewH, setViewH] = useState(400);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setViewH(el.clientHeight || 400);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const from = Math.max(0, Math.floor(el.scrollTop / rowHeight) - overscan);
      const to = Math.min(items.length, Math.ceil((el.scrollTop + viewH) / rowHeight) + overscan);
      setRange((r) => (r.from === from && r.to === to ? r : { from, to }));
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [items.length, rowHeight, viewH, overscan]);
  const total = items.length * rowHeight;
  const slice: ReactNode[] = [];
  for (let i = range.from; i < Math.min(items.length, range.to); i++) {
    slice.push(
      <div key={i} className="vrow" style={{ position: 'absolute', top: i * rowHeight, height: rowHeight, left: 0, right: 0 }}>
        {render(items[i], i)}
      </div>,
    );
  }
  return (
    <div className={cx('vlist', className)} style={{ height }}>
      {header ? <div className="vhead">{header}</div> : null}
      <div className="vbody" ref={ref}>
        {items.length === 0 ? (
          <div className="empty">{emptyText}</div>
        ) : (
          <div style={{ position: 'relative', height: total }}>{slice}</div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- mini charts */

/** Multi-series line chart on a canvas with categorical x labels (research curves). */
export function CurveChart({
  labels,
  series,
  height = 150,
  zeroLine = true,
  yLabel = 'pips',
  markerIndex,
}: {
  labels: string[];
  series: { name: string; values: (number | null)[]; color: string; dashed?: boolean; width?: number; faint?: boolean }[];
  height?: number;
  zeroLine?: boolean;
  yLabel?: string;
  markerIndex?: number;
}): React.ReactElement {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    const w = Math.max(120, parent?.clientWidth ?? 300);
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(w * ratio);
    canvas.height = Math.floor(height * ratio);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, height);
    const css = getComputedStyle(document.documentElement);
    const v = (n: string, fb: string) => css.getPropertyValue(n).trim() || fb;
    const grid = v('--border-soft', '#242b38');
    const muted = v('--muted', '#76839a');
    const font = v('--font', 'sans-serif');
    const pad = { l: 38, r: 8, t: 8, b: 18 };
    const pw = w - pad.l - pad.r;
    const ph = height - pad.t - pad.b;
    const all = series.flatMap((s) => s.values.filter((x): x is number => x !== null && Number.isFinite(x)));
    if (zeroLine) all.push(0);
    if (all.length === 0) {
      ctx.fillStyle = muted;
      ctx.font = `11px ${font}`;
      ctx.textAlign = 'center';
      ctx.fillText('no data', w / 2, height / 2);
      return;
    }
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (hi - lo < 1e-9) {
      lo -= 1;
      hi += 1;
    }
    const span = hi - lo;
    lo -= span * 0.08;
    hi += span * 0.08;
    const n = labels.length;
    const xAt = (i: number) => pad.l + (n <= 1 ? pw / 2 : (i / (n - 1)) * pw);
    const yAt = (y: number) => pad.t + ((hi - y) / (hi - lo)) * ph;
    // grid + y ticks
    ctx.strokeStyle = grid;
    ctx.fillStyle = muted;
    ctx.font = `9px ${font}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const ticks = 4;
    for (let g = 0; g <= ticks; g++) {
      const y = lo + ((hi - lo) * g) / ticks;
      const py = Math.round(yAt(y)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.l, py);
      ctx.lineTo(pad.l + pw, py);
      ctx.stroke();
      ctx.fillText(y.toFixed(Math.abs(hi - lo) < 5 ? 1 : 0), pad.l - 4, py);
    }
    ctx.textAlign = 'left';
    ctx.fillText(yLabel, pad.l + 2, pad.t + 4);
    if (zeroLine && lo < 0 && hi > 0) {
      ctx.strokeStyle = muted;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(pad.l, Math.round(yAt(0)) + 0.5);
      ctx.lineTo(pad.l + pw, Math.round(yAt(0)) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (markerIndex !== undefined && markerIndex >= 0 && markerIndex < n) {
      ctx.strokeStyle = v('--warn', '#c9a24b');
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.round(xAt(markerIndex)) + 0.5, pad.t);
      ctx.lineTo(Math.round(xAt(markerIndex)) + 0.5, pad.t + ph);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // x labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = muted;
    const every = Math.max(1, Math.ceil((n * 26) / pw));
    for (let i = 0; i < n; i += every) ctx.fillText(labels[i], xAt(i), height - 5);
    // series
    for (const s of series) {
      const color = s.color.startsWith('var(') ? v(s.color.slice(4, -1), '#5b8ec9') : s.color;
      ctx.strokeStyle = color;
      ctx.globalAlpha = s.faint ? 0.28 : 1;
      ctx.lineWidth = s.width ?? (s.faint ? 1 : 1.5);
      ctx.setLineDash(s.dashed ? [4, 3] : []);
      ctx.beginPath();
      let pen = false;
      s.values.forEach((y, i) => {
        if (y === null || !Number.isFinite(y)) {
          pen = false;
          return;
        }
        if (!pen) {
          ctx.moveTo(xAt(i), yAt(y));
          pen = true;
        } else ctx.lineTo(xAt(i), yAt(y));
      });
      ctx.stroke();
      if (!s.faint) {
        ctx.fillStyle = color;
        s.values.forEach((y, i) => {
          if (y === null || !Number.isFinite(y)) return;
          ctx.beginPath();
          ctx.arc(xAt(i), yAt(y), 2, 0, Math.PI * 2);
          ctx.fill();
        });
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }, [labels, series, height, zeroLine, yLabel, markerIndex]);
  return (
    <div style={{ position: 'relative', width: '100%', minHeight: height }}>
      <canvas ref={ref} className="spark" />
      <div className="legend-row">
        {series.filter((s) => !s.faint).map((s) => (
          <span key={s.name} className="legend-item">
            <span className="legend-swatch" style={{ background: s.color, borderStyle: s.dashed ? 'dashed' : 'solid' }} />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Histogram bars with percentile markers. */
export function Histogram({ edges, counts, marks, height = 120 }: { edges: number[]; counts: number[]; marks?: { label: string; value: number }[]; height?: number }): React.ReactElement {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    const w = Math.max(120, parent?.clientWidth ?? 300);
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(w * ratio);
    canvas.height = Math.floor(height * ratio);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, height);
    const css = getComputedStyle(document.documentElement);
    const v = (n: string, fb: string) => css.getPropertyValue(n).trim() || fb;
    const pad = { l: 6, r: 6, t: 6, b: 16 };
    const pw = w - pad.l - pad.r;
    const ph = height - pad.t - pad.b;
    if (counts.length === 0) {
      ctx.fillStyle = v('--muted', '#777');
      ctx.textAlign = 'center';
      ctx.font = `11px ${v('--font', 'sans-serif')}`;
      ctx.fillText('no data', w / 2, height / 2);
      return;
    }
    const lo = edges[0];
    const hi = edges[edges.length - 1];
    const max = Math.max(...counts);
    const xAt = (x: number) => pad.l + ((x - lo) / (hi - lo)) * pw;
    ctx.fillStyle = v('--accent', '#5b8ec9');
    counts.forEach((c, i) => {
      const x0 = xAt(edges[i]);
      const x1 = xAt(edges[i + 1]);
      const h = (c / max) * ph;
      ctx.globalAlpha = edges[i] < 0 && edges[i + 1] <= 0 ? 0.55 : 0.85;
      ctx.fillRect(x0 + 0.5, pad.t + ph - h, Math.max(1, x1 - x0 - 1), h);
    });
    ctx.globalAlpha = 1;
    ctx.font = `9px ${v('--font', 'sans-serif')}`;
    ctx.fillStyle = v('--muted', '#777');
    ctx.textAlign = 'left';
    ctx.fillText(lo.toFixed(1), pad.l, height - 4);
    ctx.textAlign = 'right';
    ctx.fillText(hi.toFixed(1), pad.l + pw, height - 4);
    if (lo < 0 && hi > 0) {
      ctx.strokeStyle = v('--muted', '#777');
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.round(xAt(0)) + 0.5, pad.t);
      ctx.lineTo(Math.round(xAt(0)) + 0.5, pad.t + ph);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const m of marks ?? []) {
      const x = Math.round(xAt(m.value)) + 0.5;
      ctx.strokeStyle = v('--warn', '#c9a24b');
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + ph);
      ctx.stroke();
      ctx.fillStyle = v('--warn', '#c9a24b');
      ctx.textAlign = 'center';
      ctx.fillText(m.label, x, pad.t + 8);
    }
  }, [edges, counts, marks, height]);
  return (
    <div style={{ position: 'relative', width: '100%', minHeight: height }}>
      <canvas ref={ref} className="spark" />
    </div>
  );
}

export function KV({ k, v, hint }: { k: ReactNode; v: ReactNode; hint?: string }): React.ReactElement {
  return (
    <div className="kv" title={hint}>
      <span className="kv-k">{k}</span>
      <span className="kv-v">{v}</span>
    </div>
  );
}
