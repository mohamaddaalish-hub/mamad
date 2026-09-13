/** Panel registry for the right rail. Subsystems append their tab here. */

import type { ComponentType } from 'react';
import type { PanelId } from '../../core/app/state.ts';
import { SettingsPanel } from '../panels/SettingsPanel.tsx';
import { DrawingsPanel } from '../panels/DrawingsPanel.tsx';
import { ReplayPanel } from '../panels/ReplayPanel.tsx';
import { BacktestPanel } from '../panels/BacktestPanel.tsx';
import type { IconName } from '../kit.tsx';

export interface PanelTab {
  id: PanelId;
  label: string;
  title: string;
  icon: IconName;
  component: ComponentType;
}

export const PANEL_TABS: PanelTab[] = [
  { id: 'backtest', label: 'Backtest', title: 'Manual trades, statistics and sessions', icon: 'target', component: BacktestPanel },
  { id: 'replay', label: 'Replay', title: 'Historical bar replay and its integrity rules', icon: 'play', component: ReplayPanel },
  { id: 'objects', label: 'Objects', title: 'Drawings on this chart', icon: 'layers', component: DrawingsPanel },
  { id: 'settings', label: 'Settings', title: 'Chart, storage and diagnostics', icon: 'settings', component: SettingsPanel },
];
