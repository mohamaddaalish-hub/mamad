/**
 * Vertical drawing toolbar, docked inside the chart so the canvas stays the
 * centre of attention. Every button carries its shortcut in the tooltip.
 */

import { useState } from 'react';
import { Btn, Icon, Slider, Sel } from '../kit.tsx';
import { drawingController } from '../../core/draw/controller.ts';
import { useDrawingCount, useDrawingSelection, useDrawings } from '../../core/draw/hooks.ts';
import { DRAWING_TOOLS, PALETTE, type DrawStyle, type DrawingKind } from '../../core/draw/model.ts';
import { useApp } from '../../core/app/state.ts';
import { cx } from '../../core/util/format.ts';

const PRIMARY: DrawingKind[] = ['hline', 'vline', 'trend', 'rect', 'pricerange', 'daterange', 'text', 'fib'];
const MORE: DrawingKind[] = ['ray', 'xline', 'circle', 'ellipse', 'triangle', 'arrow', 'pricedaterange', 'brush', 'callout', 'fibext'];

const BY_KIND = new Map(DRAWING_TOOLS.map((t) => [t.kind, t]));

export function DrawingToolbar(): React.ReactElement {
  const tool = useApp((s) => s.tool) as DrawingKind | null;
  const selection = useDrawingSelection();
  const snapshot = useDrawings();
  const [more, setMore] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const settings = drawingController.settings;
  // Style edits mutate the store, which repaints through the painter; no local tick needed.
  const bump = () => void snapshot.version;

  const setTool = (kind: DrawingKind | null) => {
    drawingController.setTool(kind);
    bump();
  };

  const toolButton = (kind: DrawingKind) => {
    const def = BY_KIND.get(kind)!;
    return (
      <Btn
        key={kind}
        size="sm"
        active={tool === kind}
        icon={def.icon as never}
        tip={`${def.label}${def.key ? ` (${def.key})` : ''} — ${def.hint}`}
        onClick={() => setTool(tool === kind ? null : kind)}
      />
    );
  };

  return (
    <div className="draw-toolbar" onPointerDown={(e) => e.stopPropagation()}>
      <Btn size="sm" icon="cursor" active={!tool} tip="Cursor — select, move, resize (Esc)" onClick={() => setTool(null)} />
      <span className="tb-sep" />
      {PRIMARY.map(toolButton)}
      <Btn size="sm" icon="chevronDown" active={more} tip={`${MORE.length} more tools`} onClick={() => setMore((v) => !v)} />
      {more ? (
        <div className="tb-more">{MORE.map(toolButton)}</div>
      ) : null}
      <span className="tb-sep" />
      <Btn
        size="sm"
        icon="target"
        active={settings.magnet}
        tip="Magnet — snap anchors to bar high/low/close"
        onClick={() => {
          drawingController.updateSettings({ magnet: !settings.magnet });
          bump();
        }}
      />
      <Btn size="sm" icon="settings" active={styleOpen} tip="Line style" onClick={() => setStyleOpen((v) => !v)} />
      {styleOpen ? (
        <div className="tb-style">
          <div className="swatches">
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                className={cx('swatch', settings.color === c && 'active')}
                style={{ background: c }}
                title={c}
                onClick={() => {
                  drawingController.updateSettings({ color: c });
                  bump();
                }}
              />
            ))}
          </div>
          <Slider
            label="Width"
            value={settings.width}
            min={0.5}
            max={5}
            step={0.5}
            format={(v) => `${v.toFixed(1)}px`}
            onChange={(v) => {
              drawingController.updateSettings({ width: v });
              bump();
            }}
          />
          <Slider
            label="Opacity"
            value={settings.opacity}
            min={0.1}
            max={1}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => {
              drawingController.updateSettings({ opacity: v });
              bump();
            }}
          />
          <Sel
            value={settings.style}
            onChange={(v) => {
              drawingController.updateSettings({ style: v as DrawStyle['style'] });
              bump();
            }}
            options={[
              { value: 'solid', label: 'Solid' },
              { value: 'dash', label: 'Dashed' },
              { value: 'dot', label: 'Dotted' },
            ]}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={settings.fill}
              onChange={(e) => {
                drawingController.updateSettings({ fill: e.target.checked });
                bump();
              }}
            />
            Fill shapes
          </label>
          {selection.length > 0 ? (
            <div className="note small dim">Applies to {selection.length} selected</div>
          ) : (
            <div className="note small dim">Applies to new drawings</div>
          )}
        </div>
      ) : null}
      <span className="tb-sep" />
      <Btn size="sm" icon="undo" tip="Undo (Ctrl/⌘ + Z)" onClick={() => drawingController.undo()} />
      <Btn size="sm" icon="redo" tip="Redo (Shift + Ctrl/⌘ + Z)" onClick={() => drawingController.redo()} />
      <Btn
        size="sm"
        icon="duplicate"
        tip="Duplicate selection (Ctrl/⌘ + D)"
        disabled={selection.length === 0}
        onClick={() => {
          drawingController.duplicateSelection();
          bump();
        }}
      />
      <Btn
        size="sm"
        icon="lock"
        tip="Lock / unlock selection (L)"
        disabled={selection.length === 0}
        onClick={() => {
          drawingController.toggleLockSelection();
          bump();
        }}
      />
      <Btn
        size="sm"
        icon="eyeOff"
        tip="Hide / show selection"
        disabled={selection.length === 0}
        onClick={() => {
          drawingController.toggleHideSelection();
          bump();
        }}
      />
      <Btn
        size="sm"
        icon="trash"
        tip="Delete selection (Del)"
        disabled={selection.length === 0}
        onClick={() => {
          drawingController.deleteSelection();
          bump();
        }}
      />
    </div>
  );
}

export function DrawingCountBadge(): React.ReactElement {
  const count = useDrawingCount();
  if (count === 0) return <></>;
  return (
    <span className="chip" title="drawings on this dataset">
      <Icon name="layers" size={10} /> {count}
    </span>
  );
}
