/**
 * Trade painting. Painters are produced through the overlay registry, so the chart
 * engine keeps no knowledge of the ledger. Everything drawn here comes from results
 * evaluated against the *gated* series — a trade entered beyond the replay cursor
 * is not part of the input, so it cannot be painted or hit-tested.
 */

import type { RenderContext } from '../chart/render.ts';
import { crisp } from '../chart/render.ts';
import { formatPips, formatPrice } from '../util/pips.ts';
import type { TradeResult } from './trade.ts';

export interface TradeGhost {
  side: 'buy' | 'sell';
  kind: 'market' | 'limit';
  index: number;
  price: number;
  stop: number | null;
  target: number | null;
}

export interface TradePaintOptions {
  results: TradeResult[];
  decimals: number;
  selectedId?: string | null;
  hiddenIds?: Set<string>;
  showFloating?: boolean;
  ghost?: TradeGhost | null;
}

export function paintTrades(rc: RenderContext, opts: TradePaintOptions): void {
  const { ctx, view, geom, style, series } = rc;
  const decimals = opts.decimals;
  const lastIndex = series ? series.count - 1 : 0;
  const xOf = (i: number): number => view.indexToX(Math.max(0, Math.min(lastIndex, i)));
  const right = geom.plotRight;
  ctx.save();
  ctx.beginPath();
  ctx.rect(geom.plotLeft, geom.plotTop, Math.max(0, right - geom.plotLeft), geom.plotBottom - geom.plotTop);
  ctx.clip();

  for (const r of opts.results) {
    if (opts.hiddenIds?.has(r.id) || !r.entry) continue;
    const selected = opts.selectedId === r.id;
    const sideColor = r.trade.side === 'buy' ? style.bull : style.bear;
    const x0 = xOf(r.entry.index);
    const y0 = view.priceToY(r.entry.price);
    const closed = r.status === 'closed';
    const won = closed ? r.netMoney > 0 : r.status === 'open' ? r.unrealizedMoney > 0 : false;
    const lineColor = r.status === 'pending' ? style.mutedText : won ? style.bull : closed ? style.bear : style.textColor;
    const xEnd = r.exit ? xOf(r.exit.index) : right;

    // Entry price line, running to the exit (or to the edge of the known data).
    ctx.globalAlpha = selected ? 1 : 0.8;
    ctx.lineWidth = selected ? 1.6 : 1.1;
    ctx.strokeStyle = lineColor;
    ctx.setLineDash(closed ? [] : [4, 3]);
    ctx.beginPath();
    ctx.moveTo(crisp(x0), crisp(y0));
    ctx.lineTo(crisp(xEnd), crisp(y0));
    ctx.stroke();
    ctx.setLineDash([]);

    // Levels, while the position is alive.
    level(rc, x0, xEnd, r.trade.stop, decimals, style.bear, 'SL', selected);
    level(rc, x0, xEnd, r.trade.target, decimals, style.bull, 'TP', selected);

    // Entry marker.
    const dir = r.trade.side === 'buy' ? 1 : -1;
    ctx.beginPath();
    ctx.moveTo(crisp(x0), crisp(y0 + dir * 5));
    ctx.lineTo(crisp(x0 - 5), crisp(y0 - dir * 5));
    ctx.lineTo(crisp(x0 + 5), crisp(y0 - dir * 5));
    ctx.closePath();
    if (r.status === 'pending') {
      ctx.strokeStyle = sideColor;
      ctx.lineWidth = 1.3;
      ctx.stroke();
      tag(rc, crisp(x0) + 10, crisp(y0) - dir * 12, `${r.trade.entryKind === 'limit' ? 'LIMIT' : 'ORDER'} ${formatPrice(r.trade.entryPrice, decimals)}`, sideColor);
    } else {
      ctx.fillStyle = sideColor;
      ctx.fill();
    }

    if (r.exit) {
      const x1 = crisp(xOf(r.exit.index));
      const y1 = crisp(view.priceToY(r.exit.price));
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(x1 - 4, y1 - 4);
      ctx.lineTo(x1 + 4, y1 + 4);
      ctx.moveTo(x1 + 4, y1 - 4);
      ctx.lineTo(x1 - 4, y1 + 4);
      ctx.stroke();
      const reason =
        r.exit.reason === 'manual'
          ? 'close'
          : r.exit.reason === 'stop-loss'
            ? 'stop'
            : r.exit.reason === 'take-profit'
              ? 'target'
              : r.exit.reason === 'ambiguous'
                ? 'both levels'
                : 'bar close';
      const flags = r.ambiguous ? ` · ${r.ambiguityPolicy === 'favorable' ? 'favorable policy' : r.ambiguityPolicy === 'adverse' ? 'adverse policy' : 'close policy'}` : '';
      tag(
        rc,
        x1 + 8,
        y1 + (dir > 0 ? 12 : -4),
        `${reason}${flags}  ${formatPips(r.netPips)} pips  ${money(r.netMoney)} ${r.moneyCcy}`.trim(),
        lineColor,
      );
    } else if (r.status === 'open' && opts.showFloating !== false && r.markedAt) {
      tag(
        rc,
        crisp(xEnd) - 176,
        crisp(view.priceToY(r.markedAt.price)) - 10,
        `floating ${formatPips(r.unrealizedPips)} pips · ${money(r.unrealizedMoney)} ${r.moneyCcy}`,
        r.unrealizedMoney >= 0 ? style.bull : style.bear,
      );
    }
  }

  const ghost = opts.ghost;
  if (ghost) {
    const color = ghost.side === 'buy' ? style.bull : style.bear;
    const y = crisp(view.priceToY(ghost.price));
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(geom.plotLeft, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.restore();
    tag(
      rc,
      geom.plotLeft + 10,
      y - 18,
      `${ghost.side.toUpperCase()} ${ghost.kind === 'limit' ? 'limit' : 'at bar close'} · bar ${ghost.index + 1}/${lastIndex + 1} @ ${formatPrice(ghost.price, decimals)}`,
      color,
    );
    level(rc, xOf(ghost.index), right, ghost.stop, decimals, style.bear, 'SL', false);
    level(rc, xOf(ghost.index), right, ghost.target, decimals, style.bull, 'TP', false);
  }
  ctx.restore();
}

function level(
  rc: RenderContext,
  x0: number,
  x1: number,
  price: number | null,
  decimals: number,
  color: string,
  prefix: string,
  emphasize: boolean,
): void {
  if (price === null || !Number.isFinite(price)) return;
  const { ctx, view } = rc;
  const y = crisp(view.priceToY(price));
  if (!Number.isFinite(y)) return;
  ctx.save();
  ctx.globalAlpha = emphasize ? 0.95 : 0.45;
  ctx.setLineDash([2, 3]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(crisp(x0), y);
  ctx.lineTo(crisp(x1), y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
  if (emphasize) tag(rc, crisp(x1) - 74, y - 8, `${prefix} ${formatPrice(price, decimals)}`, color);
}

function money(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}`;
}

function tag(rc: RenderContext, x: number, y: number, text: string, accent: string): void {
  if (!text) return;
  const { ctx, geom, style } = rc;
  ctx.save();
  ctx.font = `${style.fontSize - 1}px ${style.fontFamily}`;
  const w = ctx.measureText(text).width + 8;
  const h = 14;
  const left = Math.max(geom.plotLeft, Math.min(x, geom.width - w - 1));
  const top = Math.max(geom.plotTop, Math.min(y - h / 2, geom.height - h));
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = style.axisBg;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(crisp(left), crisp(top), w, h);
  ctx.fill();
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = style.textColor;
  ctx.fillText(text, left + 4, top + 10);
  ctx.restore();
}

/** Distance in pips implied by a price delta, for the ghost risk readout. */
export function pipsBetween(a: number | null, b: number | null, pipSize: number): number | null {
  if (a === null || b === null || !(pipSize > 0)) return null;
  return (a - b) / pipSize;
}
