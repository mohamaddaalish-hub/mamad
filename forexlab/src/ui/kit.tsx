/** Shared UI primitives + an inline 16px icon set (no icon dependency). */

import React, { useEffect, useRef, type ReactNode } from 'react';
import { cx } from '../core/util/format.ts';

export type IconName =
  | 'play'
  | 'pause'
  | 'step'
  | 'stepBack'
  | 'restart'
  | 'close'
  | 'trash'
  | 'plus'
  | 'search'
  | 'star'
  | 'lock'
  | 'unlock'
  | 'eye'
  | 'eyeOff'
  | 'undo'
  | 'redo'
  | 'expand'
  | 'settings'
  | 'import'
  | 'candles'
  | 'bars'
  | 'line'
  | 'area'
  | 'hline'
  | 'vline'
  | 'trend'
  | 'ray'
  | 'xline'
  | 'rect'
  | 'circle'
  | 'ellipse'
  | 'triangle'
  | 'arrow'
  | 'priceRange'
  | 'dateRange'
  | 'priceDateRange'
  | 'brush'
  | 'text'
  | 'callout'
  | 'fib'
  | 'fibExt'
  | 'save'
  | 'folder'
  | 'layers'
  | 'news'
  | 'chart'
  | 'flask'
  | 'clock'
  | 'chevronDown'
  | 'chevronRight'
  | 'drag'
  | 'duplicate'
  | 'target'
  | 'zoomIn'
  | 'zoomOut'
  | 'fit'
  | 'cursor';

const PATHS: Record<IconName, ReactNode> = {
  play: <path d="M5 3.5v9l7.5-4.5z" />,
  pause: (
    <>
      <rect x="4.5" y="3.5" width="2.5" height="9" />
      <rect x="9" y="3.5" width="2.5" height="9" />
    </>
  ),
  step: (
    <>
      <path d="M4 3.5v9l6.5-4.5z" />
      <rect x="11.4" y="3.5" width="1.6" height="9" />
    </>
  ),
  stepBack: (
    <>
      <path d="M12 3.5v9l-6.5-4.5z" />
      <rect x="3" y="3.5" width="1.6" height="9" />
    </>
  ),
  restart: <path d="M13 8a5 5 0 1 1-1.6-3.7M13 3v3h-3" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  trash: <path d="M4 5h8M6.5 5V3.5h3V5M5 5l.6 7.5h4.8L11 5" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  search: (
    <>
      <circle cx="7.2" cy="7.2" r="3.6" />
      <path d="M10 10l3 3" />
    </>
  ),
  star: <path d="M8 2.5l1.7 3.6 3.8.5-2.8 2.7.7 3.9L8 11.9l-3.1 1.3.7-3.9L2.7 6.6l3.8-.5z" />,
  lock: (
    <>
      <rect x="4" y="7" width="8" height="6" rx="1" />
      <path d="M6 7V5.5a2 2 0 0 1 4 0V7" />
    </>
  ),
  unlock: (
    <>
      <rect x="4" y="7" width="8" height="6" rx="1" />
      <path d="M6 7V5.5a2 2 0 0 1 3.9-.5" />
    </>
  ),
  eye: (
    <>
      <path d="M1.5 8S4 4 8 4s6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4z" />
      <circle cx="8" cy="8" r="1.8" />
    </>
  ),
  eyeOff: <path d="M2 2l12 12M6 5.5A7.6 7.6 0 0 1 8 5.2c4 0 6.5 3.8 6.5 3.8a11 11 0 0 1-2 2.2M4.4 6A11.4 11.4 0 0 0 1.5 9s2.5 3.8 6.5 3.8a7 7 0 0 0 1.7-.2" />,
  undo: <path d="M6 6H3.5V3.5M4 9.5A5 5 0 1 0 9 4" />,
  redo: <path d="M10 6h2.5V3.5M12 9.5A5 5 0 1 1 7 4" />,
  expand: <path d="M3 6V3h3M13 10v3h-3M13 6V3h-3M3 10v3h3" />,
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.6M8 12.6v1.6M2.6 8H1M15 8h-1.6M3.9 3.9 2.8 2.8M12.1 12.1l1.1 1.1M12.1 3.9l1.1-1.1M3.9 12.1l-1.1 1.1" />
    </>
  ),
  import: <path d="M8 2v7.5M5 6.5 8 9.5l3-3M3 13h10" />,
  candles: (
    <>
      <path d="M4.5 2.5v11M11.5 2.5v11" />
      <rect x="3" y="5" width="3" height="5" />
      <rect x="10" y="6.5" width="3" height="4" />
    </>
  ),
  bars: <path d="M4 3v10M4 5.5h2.5M4 9.5H1.5M11 3v10M11 5h2.5M11 10H8.5" />,
  line: <path d="M2 11.5 5.5 7l2.5 2.5L11 5l3 4" />,
  area: <path d="M2 11.5 5.5 7l2.5 2.5L11 5l3 4V13H2z" />,
  hline: <path d="M2 8h12" />,
  vline: <path d="M8 2v12" />,
  trend: <path d="M2.5 12.5 13 3.5" />,
  ray: <path d="M2.5 12.5 13 3.5M13 3.5l-2.6.3M13 3.5l-.4 2.6" />,
  xline: <path d="M1 14 15 2M3.5 12.5l1.2 1.2M11.3 4l1.2 1.2" />,
  rect: <rect x="2.5" y="4" width="11" height="8" />,
  circle: <circle cx="8" cy="8" r="5" />,
  ellipse: <ellipse cx="8" cy="8" rx="6" ry="3.6" />,
  triangle: <path d="M8 2.5 14 13H2z" />,
  arrow: <path d="M2.5 10.5h7V13l4-4.5-4-4.5v2.5h-7z" />,
  priceRange: (
    <>
      <path d="M12 3v10" />
      <rect x="3" y="5.5" width="7" height="5" />
    </>
  ),
  dateRange: (
    <>
      <path d="M8 2v12" />
      <rect x="3.5" y="4.5" width="9" height="7" strokeDasharray="2 1.5" fill="none" />
    </>
  ),
  priceDateRange: <rect x="2.5" y="4.5" width="11" height="7" />,
  brush: <path d="M3 12.5c2.5.6 4-1 3.6-2.6L11 4l1.6 1.4-4 4.6c.4 2.6-2 3.6-5.6 2.5z" />,
  text: <path d="M3.5 4h9M8 4v8.5M6 12.5h4" />,
  callout: <path d="M2.5 3.5h11v6h-6l-2.5 2.5v-2.5h-2.5z" />,
  fib: (
    <>
      <path d="M2 3h12M2 6h12M2 9h12M2 12.5h12" />
    </>
  ),
  fibExt: (
    <>
      <path d="M2 2.5h12M2 6h12M2 9.5h12M2 13h12" strokeDasharray="3 1.5" />
    </>
  ),
  save: <path d="M3 3h8l2 2v8H3zM5.5 3v4h5V3M5.5 13V9.5h5V13" />,
  folder: <path d="M2 4.5h4l1.5 1.5H14V12H2z" />,
  layers: <path d="M8 2 2 5.5 8 9l6-3.5zM2 9l6 3.5L14 9M2 11.5 8 15l6-3.5" />,
  news: <path d="M2.5 3.5h11v9h-11zM4.5 6h6M4.5 8h6M4.5 10h4" />,
  chart: <path d="M2 13h12M4 11V7M7 11V4M10 11V8M13 11V5.5" />,
  flask: <path d="M6.5 2h3M7 2v4L3.5 12a1.5 1.5 0 0 0 1.4 2h6.2a1.5 1.5 0 0 0 1.4-2L9 6V2" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.8V8l2.4 1.6" />
    </>
  ),
  chevronDown: <path d="M4 6.5 8 10l4-3.5" />,
  chevronRight: <path d="M6.5 4 10 8l-3.5 4" />,
  drag: <path d="M6 4h1M9 4h1M6 8h1M9 8h1M6 12h1M9 12h1" />,
  duplicate: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
      <path d="M10.5 3.5h-8v8" />
    </>
  ),
  target: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="1.4" />
      <path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15" />
    </>
  ),
  zoomIn: (
    <>
      <circle cx="7.2" cy="7.2" r="3.6" />
      <path d="M10 10l3 3M5.7 7.2h3M7.2 5.7v3" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="7.2" cy="7.2" r="3.6" />
      <path d="M10 10l3 3M5.7 7.2h3" />
    </>
  ),
  fit: <path d="M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3M6.5 6.5h3v3h-3z" />,
  cursor: <path d="M4 2.5l8 5-3.6 1L10 12l-1.8.8-1.6-3.4-2.6 2z" />,
};

export function Icon({ name, size = 14, filled = false }: { name: IconName; size?: number; filled?: boolean }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

interface BtnProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: IconName;
  active?: boolean;
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'xs';
  tip?: string;
  block?: boolean;
}

export function Btn({ icon, active, variant = 'default', size, tip, block, className, children, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      className={cx(
        'btn',
        variant === 'primary' && 'primary',
        variant === 'ghost' && 'ghost',
        variant === 'danger' && 'danger',
        size && 'sm',
        size === 'xs' && 'xs',
        block && 'block',
        icon && !children && 'icon',
        active && 'active',
        className,
      )}
      aria-pressed={active}
      data-tip={tip}
      title={tip}
      {...rest}
    >
      {icon ? <Icon name={icon} size={size === 'xs' ? 12 : 14} /> : null}
      {children}
    </button>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx('field', className)}>
      <label>
        {label}
        {hint ? <span className="dim" style={{ marginLeft: 4, textTransform: 'none' }}>{hint}</span> : null}
      </label>
      {children}
    </div>
  );
}

export function Sel<T extends string | number>({
  value,
  onChange,
  options,
  className,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; title?: string }[];
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <select
      className={cx('select', className)}
      value={String(value)}
      aria-label={ariaLabel}
      onChange={(e) => {
        const raw = e.target.value;
        const hit = options.find((o) => String(o.value) === raw);
        onChange((hit ? hit.value : (raw as T)) as T);
      }}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)} title={o.title}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function NumInput({
  value,
  onChange,
  step = 1,
  min,
  max,
  suffix,
  className,
  decimals,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  className?: string;
  decimals?: number;
}) {
  const [text, setText] = React.useState(fmtNum(value, decimals));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(fmtNum(value, decimals));
  }, [value, decimals]);
  const commit = (raw: string) => {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      let v = n;
      if (min !== undefined) v = Math.max(min, v);
      if (max !== undefined) v = Math.min(max, v);
      onChange(v);
      setText(fmtNum(v, decimals));
    } else setText(fmtNum(value, decimals));
  };
  return (
    <div className={cx('row', className)} style={{ gap: 3 }}>
      <input
        className="input mono"
        value={text}
        inputMode="decimal"
        step={step}
        onFocus={() => (focused.current = true)}
        onBlur={(e) => {
          focused.current = false;
          commit(e.target.value);
        }}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(min !== undefined ? Math.max(min, n) : n);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const dir = e.key === 'ArrowUp' ? 1 : -1;
            const next = value + dir * step * (e.shiftKey ? 10 : 1);
            onChange(max !== undefined ? Math.min(max, next) : next);
          }
        }}
      />
      {suffix ? <span className="dim nowrap">{suffix}</span> : null}
    </div>
  );
}

function fmtNum(v: number, decimals?: number): string {
  if (!Number.isFinite(v)) return '';
  if (decimals !== undefined) return v.toFixed(decimals);
  return String(Math.round(v * 1e6) / 1e6);
}

export function Check({
  checked,
  onChange,
  label,
  disabled,
  count,
  indeterminate,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  count?: number;
  indeterminate?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(indeterminate) && !checked;
  }, [indeterminate, checked]);
  return (
    <label className={cx('check', disabled && 'disabled')}>
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {count !== undefined ? <span className="dim" style={{ marginLeft: 'auto', fontSize: 10 }}>{count}</span> : null}
    </label>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  format,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  label?: string;
  format?: (v: number) => string;
}) {
  return (
    <div className="field">
      {label ? (
        <div className="row between">
          <label>{label}</label>
          <span className="num">{format ? format(value) : value}</span>
        </div>
      ) : null}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export function Chip({ children, tone, title }: { children: ReactNode; tone?: 'accent' | 'warn' | 'bull' | 'bear'; title?: string }) {
  return (
    <span className={cx('chip', tone && tone)} title={title}>
      {children}
    </span>
  );
}

export function Section({ title, right, children, className }: { title?: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('panel-section', className)}>
      {title ? (
        <div className="row between" style={{ marginBottom: 6 }}>
          <h4 className="section-title" style={{ margin: 0 }}>{title}</h4>
          {right}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { id: T; label: string; title?: string }[];
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map((it) => (
        <button
          key={it.id}
          role="tab"
          type="button"
          className={cx('tab', value === it.id && 'active')}
          aria-selected={value === it.id}
          title={it.title}
          onClick={() => onChange(it.id)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  narrow,
  subtitle,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  narrow?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', narrow && 'narrow')} role="dialog" aria-modal="true">
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          {subtitle ? <span className="dim" style={{ fontSize: 11 }}>{subtitle}</span> : null}
          <Btn className="close-x" icon="close" onClick={onClose} tip="Close (Esc)" size="xs" />
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ProgressBar({ ratio, label }: { ratio: number; label?: string }) {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  return (
    <div className="row" style={{ gap: 8 }}>
      <div className="progress" style={{ flex: '1 1 auto' }}>
        <div style={{ width: `${pct}%` }} />
      </div>
      {label ? <span className="num dim nowrap">{label}</span> : null}
    </div>
  );
}

export function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: 'pos' | 'neg' | 'dim';
  hint?: string;
}) {
  return (
    <div className="row between" style={{ gap: 8 }} title={hint}>
      <span className="dim" style={{ fontSize: 11 }}>{label}</span>
      <span className={cx('num', tone === 'pos' && 'pos', tone === 'neg' && 'neg', tone === 'dim' && 'dim')} style={{ fontWeight: 600 }}>
        {value}
      </span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** Sparkline / curve canvas: equity, drawdown, reaction curves. */
export function Sparkline({
  points,
  height = 74,
  color = 'var(--accent)',
  fill = true,
  zeroLine = false,
  labels,
  second,
  secondColor = 'var(--muted)',
  min,
  max,
}: {
  points: number[];
  height?: number;
  color?: string;
  fill?: boolean;
  zeroLine?: boolean;
  labels?: string[];
  second?: number[];
  secondColor?: string;
  min?: number;
  max?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    const w = Math.max(60, parent?.clientWidth ?? 240);
    const h = height;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(w * ratio);
    canvas.height = Math.floor(h * ratio);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const grid = css.getPropertyValue('--border-soft').trim() || '#242b38';
    const pad = { l: 2, r: 2, t: 4, b: labels && labels.length ? 12 : 4 };
    const plotW = Math.max(1, w - pad.l - pad.r);
    const plotH = Math.max(1, h - pad.t - pad.b);
    let lo = min ?? Math.min(...points, ...(zeroLine ? [0] : []));
    let hi = max ?? Math.max(...points, ...(zeroLine ? [0] : []));
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    if (hi - lo < 1e-9) {
      lo -= 1;
      hi += 1;
    }
    const xAt = (i: number) => pad.l + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
    const yAt = (v: number) => pad.t + ((hi - v) / (hi - lo)) * plotH;
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let g = 0; g <= 2; g++) {
      const y = pad.t + (g / 2) * plotH;
      ctx.moveTo(pad.l, Math.round(y) + 0.5);
      ctx.lineTo(pad.l + plotW, Math.round(y) + 0.5);
    }
    ctx.stroke();
    const resolve = (v: string) => (v.startsWith('var(') ? css.getPropertyValue(v.slice(4, -1)).trim() || '#5b8ec9' : v);
    if (zeroLine && lo < 0 && hi > 0) {
      ctx.strokeStyle = grid;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(pad.l, Math.round(yAt(0)) + 0.5);
      ctx.lineTo(pad.l + plotW, Math.round(yAt(0)) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (points.length > 1) {
      if (fill) {
        const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + plotH);
        const base = resolve(color);
        grad.addColorStop(0, hexA(base, 0.28));
        grad.addColorStop(1, hexA(base, 0.02));
        ctx.beginPath();
        ctx.moveTo(xAt(0), yAt(points[0]));
        for (let i = 1; i < points.length; i++) ctx.lineTo(xAt(i), yAt(points[i]));
        ctx.lineTo(xAt(points.length - 1), zeroLine && lo < 0 ? yAt(Math.max(lo, 0)) : pad.t + plotH);
        ctx.lineTo(xAt(0), zeroLine && lo < 0 ? yAt(Math.max(lo, 0)) : pad.t + plotH);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.moveTo(xAt(0), yAt(points[0]));
      for (let i = 1; i < points.length; i++) ctx.lineTo(xAt(i), yAt(points[i]));
      ctx.strokeStyle = resolve(color);
      ctx.lineWidth = 1.3;
      ctx.stroke();
      if (second && second.length > 1) {
        ctx.beginPath();
        ctx.setLineDash([3, 2]);
        ctx.moveTo(xAt(0), yAt(second[0]));
        for (let i = 1; i < second.length; i++) ctx.lineTo(xAt(i), yAt(second[i]));
        ctx.strokeStyle = resolve(secondColor);
        ctx.lineWidth = 1.1;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    } else if (points.length === 1) {
      ctx.fillStyle = resolve(color);
      ctx.fillRect(xAt(0) - 1.5, yAt(points[0]) - 1.5, 3, 3);
    }
    if (labels && labels.length) {
      ctx.fillStyle = css.getPropertyValue('--muted').trim() || '#76839a';
      ctx.font = '9px ' + (css.getPropertyValue('--font') || 'sans-serif');
      ctx.textBaseline = 'alphabetic';
      const idxs = labels.length === 1 ? [0] : [0, Math.floor((points.length - 1) / 2), points.length - 1];
      const anchors: CanvasTextAlign[] = labels.length === 1 ? ['center'] : ['left', 'center', 'right'];
      idxs.forEach((idx, k) => {
        const text = labels[Math.min(labels.length - 1, Math.round((idx / Math.max(1, points.length - 1)) * (labels.length - 1)))];
        ctx.textAlign = anchors[k] ?? 'center';
        ctx.fillText(text, xAt(idx), h - 2);
      });
    }
  }, [points, labels, height, color, second, fill, zeroLine, min, max, secondColor]);
  return (
    <div style={{ position: 'relative', width: '100%', minHeight: height }}>
      <canvas ref={ref} className="spark" />
    </div>
  );
}

function hexA(color: string, alpha: number): string {
  const c = color.trim();
  if (c.startsWith('#')) {
    const hex = c.slice(1);
    const full = hex.length === 3 ? hex.split('').map((x) => x + x).join('') : hex.slice(0, 6);
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (m) {
    const parts = m[1].split(',').map((p) => p.trim());
    return `rgba(${parts[0]},${parts[1]},${parts[2]},${alpha})`;
  }
  return c;
}

/** Click-to-edit inline text (used by drawings manager and session names). */
export function InlineEdit({ value, onSave, className }: { value: string; onSave: (v: string) => void; className?: string }) {
  const [text, setText] = React.useState(value);
  const [editing, setEditing] = React.useState(false);
  useEffect(() => setText(value), [value]);
  if (!editing) {
    return (
      <span
        className={className}
        onDoubleClick={(e) => {
          e.preventDefault();
          setEditing(true);
        }}
        title="Double-click to rename"
      >
        {value}
      </span>
    );
  }
  return (
    <input
      className="input"
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (text.trim() && text !== value) onSave(text.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(value);
          setEditing(false);
        }
      }}
    />
  );
}
