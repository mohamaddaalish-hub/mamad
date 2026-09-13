/** Application shell: top bar, rails, chart surface, right panel, status bar. */

import { useEffect } from 'react';
import { Topbar } from './Topbar.tsx';
import { LeftRail } from './LeftRail.tsx';
import { StatusBar } from './StatusBar.tsx';
import { ChartSurface } from './ChartSurface.tsx';
import { RightPanel } from './RightPanel.tsx';
import { appStore, restoreUiState, useApp } from '../../core/app/state.ts';
import { datasetRegistry } from '../../core/data/datasets.ts';
import { installGlobalShortcuts } from '../../core/app/shortcutsShell.ts';
import { installDrawingShortcuts } from '../../core/draw/shortcuts.ts';
import { installReplayShortcuts } from '../../core/replay/shortcuts.ts';
import { closeDialog, useDialog } from '../../core/app/dialogs.ts';
import { ImportDialog } from '../panels/ImportDialog.tsx';
import { GoToDateDialog } from '../panels/GoToDate.tsx';
import { ShortcutsDialog } from '../panels/ShortcutsDialog.tsx';

export function App(): React.ReactElement {
  const leftOpen = useApp((s) => s.leftOpen);
  const rightOpen = useApp((s) => s.rightOpen);
  const fullscreen = useApp((s) => s.fullscreen);
  const theme = useApp((s) => s.chart.theme);
  const dialog = useDialog((s) => s.open);

  useEffect(() => {
    void (async () => {
      await datasetRegistry.hydrate();
      await restoreUiState();
      appStore.set({ ready: true });
    })();
    installGlobalShortcuts();
    installDrawingShortcuts();
    return installReplayShortcuts();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.scheme = theme === 'lightProfessional' ? 'light' : 'dark';
  }, [theme]);

  const showLeft = leftOpen && !fullscreen;
  const showRight = rightOpen && !fullscreen;

  return (
    <div className={fullscreen ? 'app fullscreen' : 'app'}>
      <Topbar />
      <div
        className={`app-body${showLeft ? '' : ' no-left'}${showRight ? '' : ' no-right'}`}
        style={{ '--right-w': showRight ? '332px' : '0px' } as React.CSSProperties}
      >
        {showLeft ? <LeftRail /> : <div />}
        <main className="chart-area">
          <ChartSurface id="main" />
        </main>
        {showRight ? <RightPanel /> : <div />}
      </div>
      <StatusBar />
      {dialog === 'goto' ? <GoToDateDialog onClose={closeDialog} /> : null}
      {dialog === 'shortcuts' ? <ShortcutsDialog /> : null}
      {dialog === 'import' ? <ImportDialog /> : null}
    </div>
  );
}
