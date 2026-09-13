/**
 * Drawings manager: the low-noise place to find, select, hide, lock, reorder,
 * export and delete chart objects. Kept in the right rail so the chart never
 * shares space with a modal.
 */

import { useRef, useState } from 'react';
import { Btn, Chip, Empty, Icon, Section } from '../kit.tsx';
import { drawingController } from '../../core/draw/controller.ts';
import { drawingStore } from '../../core/draw/store.ts';
import { useDrawings } from '../../core/draw/hooks.ts';
import { TOOL_BY_KIND, type Drawing } from '../../core/draw/model.ts';
import { formatDate } from '../../core/time/tz.ts';
import { cx } from '../../core/util/format.ts';
import { appStore, useApp } from '../../core/app/state.ts';
import { newsStore, useNews } from '../../core/econ/store.ts';
import { useResearch } from '../../core/econ/service.ts';
import { filterStore } from '../../core/econ/filters.ts';
import { Check } from '../kit.tsx';

export function DrawingsPanel(): React.ReactElement {
  const { list, selection } = useDrawings();
  const tz = useApp((s) => s.tz);
  const datasetId = useApp((s) => s.datasetId);
  const [filter, setFilter] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const selected = new Set(selection);
  const rows = list.filter((d) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return d.kind.includes(q) || d.text.toLowerCase().includes(q) || d.symbol.toLowerCase().includes(q);
  });

  const toggleRow = (d: Drawing, additive: boolean): void => {
    if (additive) {
      const next = selected.has(d.id) ? selection.filter((id) => id !== d.id) : [...selection, d.id];
      drawingStore.select(next);
    } else {
      drawingStore.select([d.id]);
    }
    drawingController.focusSelection();
  };

  const exportJson = (): void => {
    const text = drawingStore.exportJson();
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `forexlab-drawings-${datasetId ?? 'chart'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="panel-body">
      <Section
        title={`Drawings · ${list.length}`}
        right={
          <div className="row" style={{ gap: 2 }}>
            <Btn size="xs" icon="plus" tip="Import a drawings JSON file" onClick={() => fileRef.current?.click()} />
            <Btn size="xs" icon="save" tip="Export drawings for this dataset as JSON" onClick={exportJson} disabled={list.length === 0} />
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                void f.text().then((text) => drawingStore.importJson(text));
                e.target.value = '';
              }}
            />
          </div>
        }
      >
        <div className="row" style={{ gap: 4, marginBottom: 6 }}>
          <input className="input" placeholder="Filter kind, note, symbol" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <Btn size="xs" tip="Select all (Ctrl/⌘ + A)" onClick={drawingController.selectAll}>
            All
          </Btn>
          <Btn
            size="xs"
            tip="Deselect"
            onClick={() => {
              drawingStore.clearSelection();
            }}
          >
            None
          </Btn>
        </div>
        <div className="row wrap" style={{ gap: 4, marginBottom: 6 }}>
          <Btn
            size="xs"
            icon="eyeOff"
            tip="Hide / show everything (Shift + H)"
            onClick={() => drawingController.hideAll(list.some((d) => !d.hidden))}
            disabled={list.length === 0}
          />
          <Btn
            size="xs"
            icon="lock"
            tip="Lock / unlock the selection"
            disabled={selection.length === 0}
            onClick={() => drawingController.toggleLockSelection()}
          />
          <Btn
            size="xs"
            icon="duplicate"
            tip="Duplicate the selection (Ctrl/⌘ + D)"
            disabled={selection.length === 0}
            onClick={() => drawingController.duplicateSelection()}
          />
          <Btn
            size="xs"
            icon="trash"
            tip="Delete the selection (Del)"
            disabled={selection.length === 0}
            onClick={() => drawingController.deleteSelection()}
          />
          {selection.length > 0 ? <Chip>{selection.length} selected</Chip> : null}
        </div>

        {rows.length === 0 ? (
          <Empty>
            {list.length === 0 ? 'No drawings yet.' : 'No drawings match the filter.'}
            <br />
            Pick a tool from the chart toolbar — H, V and T are the fast ones.
          </Empty>
        ) : (
          <div className="list draw-list">
            {rows.map((d) => {
              const tool = TOOL_BY_KIND[d.kind];
              return (
                <div
                  key={d.id}
                  className={cx('list-row', selected.has(d.id) && 'selected', d.hidden && 'muted')}
                  onClick={(e) => toggleRow(d, e.shiftKey || e.ctrlKey || e.metaKey)}
                  onDoubleClick={() => drawingController.promptText(d.id, d.text)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && toggleRow(d, e.shiftKey)}
                  title={`${tool?.label ?? d.kind} · ${d.anchors.length} anchor(s) · ${formatDate(d.anchors[0]?.t ?? 0, tz)}`}
                >
                  <span className="row-icon" style={{ color: d.style.color }}>
                    <Icon name={(tool?.icon ?? 'layers') as never} size={13} />
                  </span>
                  <span className="cell">
                    <span className="title">{d.text || tool?.label || d.kind}</span>
                    <span className="sub mono">
                      {describe(d, tz)}
                      {d.locked ? ' · locked' : ''}
                      {d.hidden ? ' · hidden' : ''}
                    </span>
                  </span>
                  <span className="row-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      title={d.hidden ? 'Show' : 'Hide'}
                      onClick={(e) => {
                        e.stopPropagation();
                        drawingStore.setHidden(d.id, !d.hidden);
                      }}
                    >
                      <Icon name={d.hidden ? 'eyeOff' : 'eye'} size={12} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title={d.locked ? 'Unlock' : 'Lock'}
                      onClick={(e) => {
                        e.stopPropagation();
                        drawingStore.setLocked(d.id, !d.locked);
                      }}
                    >
                      <Icon name={d.locked ? 'lock' : 'unlock'} size={12} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="Bring forward"
                      onClick={(e) => {
                        e.stopPropagation();
                        drawingStore.raise(d.id, 1);
                      }}
                    >
                      <Icon name="chevronRight" size={12} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="Send backward"
                      onClick={(e) => {
                        e.stopPropagation();
                        drawingStore.raise(d.id, -1);
                      }}
                    >
                      <Icon name="chevronDown" size={12} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="Delete"
                      disabled={d.locked}
                      onClick={(e) => {
                        e.stopPropagation();
                        drawingStore.remove(d.id);
                      }}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <NewsObjects />

      <Section title="History">
        <div className="row" style={{ gap: 4 }}>
          <Btn size="xs" icon="undo" tip="Undo (Ctrl/⌘ + Z)" onClick={() => drawingController.undo()} disabled={!drawingStore.canUndo}>
            Undo
          </Btn>
          <Btn size="xs" icon="redo" tip="Redo (Shift + Ctrl/⌘ + Z)" onClick={() => drawingController.redo()} disabled={!drawingStore.canRedo}>
            Redo
          </Btn>
        </div>
        <div className="note small dim" style={{ marginTop: 6 }}>
          Drawings are anchored to time and price, so they survive zoom, pan, timeframe changes and fullscreen. They
          are stored locally with the dataset and clipped by the replay barrier.
        </div>
      </Section>
    </div>
  );
}

function describe(d: Drawing, tz: string): string {
  const first = d.anchors[0];
  if (!first) return '—';
  const time = formatDate(first.t, tz);
  const price = Number.isFinite(first.p) ? first.p.toFixed(5) : '—';
  if (d.kind === 'hline') return price;
  if (d.kind === 'vline') return time;
  const last = d.anchors[d.anchors.length - 1];
  return `${time} → ${formatDate(last.t, tz)} · ${price}${d.anchors.length > 2 ? ` → ${last.p.toFixed(5)}` : ''}`;
}

/** Objects Manager extension: news markers are chart objects too — show/hide, per-event hide, restore. */
function NewsObjects(): React.ReactElement {
  const showOnChart = useNews((s) => s.showOnChart);
  const hiddenIds = useNews((s) => s.hiddenIds);
  const research = useResearch();
  const hiddenEvents = hiddenIds.filter((id) => !id.startsWith('cmp:')).length;
  const filtered = research.filtered.length;
  return (
    <Section
      title="News markers"
      right={
        <Chip title="Events currently matching the news filter and known at the replay position">{filtered}</Chip>
      }
    >
      <Check checked={showOnChart} onChange={(v) => newsStore.set({ showOnChart: v })} label="Show news markers on the chart" />
      <div className="row wrap" style={{ gap: 4, marginTop: 6 }}>
        <Btn size="xs" onClick={() => { appStore.set({ panel: 'news', rightOpen: true }); filterStore.set({ drawerOpen: true }); }} tip="Markers follow the News filter">
          Edit filter…
        </Btn>
        <Btn size="xs" disabled={hiddenEvents === 0} onClick={() => newsStore.set((s) => ({ hiddenIds: s.hiddenIds.filter((id) => id.startsWith('cmp:')) }))} tip="Restore individually hidden events">
          Restore {hiddenEvents} hidden
        </Btn>
      </div>
      <div className="note small dim" style={{ marginTop: 6 }}>
        Markers are drawn for the visible range only and never for releases after the replay position. Hide single events from their detail view.
      </div>
    </Section>
  );
}
