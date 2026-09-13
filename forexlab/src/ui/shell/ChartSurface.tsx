/**
 * React host for the imperative chart engine.
 *
 * The engine is created once per surface; data/style changes are pushed in
 * imperatively. Nothing here re-renders on pan/zoom.
 */

import { useEffect, useRef } from 'react';
import { ChartEngine, type OverlayPainter } from '../../core/chart/engine.ts';
import { appStore, useApp } from '../../core/app/state.ts';
import { viewStore } from '../../core/app/viewState.ts';
import { bindEngine, refreshSeries } from '../../core/app/actions.ts';
import { overlayRegistry } from '../../core/app/overlays.ts';
import { ChartNav } from './ChartNav.tsx';
import { DrawingToolbar } from '../controls/DrawingToolbar.tsx';
import { ReplayBar } from '../controls/ReplayBar.tsx';
import { TradeToolbar } from '../controls/TradeToolbar.tsx';
import { drawingController } from '../../core/draw/controller.ts';
import { newsMarkers } from '../../core/econ/markers.ts';
import { tradeController } from '../../core/backtest/controller.ts';
import { quickImport } from '../../core/csv/importFlow.ts';

export function ChartSurface({ id = 'main' }: { id?: string }): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<ChartEngine | null>(null);
  const settings = useApp((s) => s.chart);
  const tool = useApp((s) => s.tool);
  const epoch = useApp((s) => s.datasetEpoch);
  const replaying = useApp((s) => s.replay.active);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new ChartEngine(canvas, {
      settings: appStore.get().chart,
      hooks: {
        onViewChanged: (snap) => {
          viewStore.set({
            rightIndex: snap.rightIndex,
            pxPerBar: snap.pxPerBar,
            visibleBars: Math.round(snap.pxPerBar > 0 ? engine.getVisibleRange().to - engine.getVisibleRange().from : 0),
          });
        },
        onHover: (info) => viewStore.set({ hover: info }),
      },
    });
    engineRef.current = engine;
    if (id === 'main') bindEngine(engine);
    if (id === 'main') {
      drawingController.attach(engine);
      tradeController.attach(engine);
      newsMarkers.attach(engine);
    }
    overlayRegistry.attach(id, engine);
    void refreshSeries({ keepAnchor: false });
    return () => {
      if (id === 'main') {
        drawingController.detach();
        tradeController.detach();
        newsMarkers.detach();
      }
      overlayRegistry.detach(id);
      if (id === 'main') bindEngine(null);
      engine.destroy();
      engineRef.current = null;
    };
  }, [id]);

  useEffect(() => {
    engineRef.current?.setSettings(settings);
  }, [settings]);

  useEffect(() => {
    overlayRegistry.sync(id);
  }, [id, epoch, replaying, settings]);

  useEffect(() => {
    engineRef.current?.setToolCursor(tool ? 'crosshair' : undefined);
  }, [tool]);

  const layers: OverlayPainter[] = [];
  void layers;

  return (
    <div
      className="chart-surface"
      ref={hostRef}
      data-surface={id}
      onDragOver={(e) => {
        if (e.dataTransfer.types?.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        const f = e.dataTransfer.files?.[0];
        if (!f) return;
        e.preventDefault();
        void quickImport(f);
      }}
    >
      <canvas ref={canvasRef} />
      {id === 'main' ? <ChartNav /> : null}
      {id === 'main' ? <DrawingToolbar /> : null}
      {id === 'main' ? <TradeToolbar /> : null}
      {id === 'main' ? <ReplayBar /> : null}
    </div>
  );
}
