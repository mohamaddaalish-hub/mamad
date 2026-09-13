/** Panel registry for the right rail. Subsystems append their tab here. */

import type { ComponentType } from 'react';
import type { PanelId } from '../../core/app/state.ts';
import { SettingsPanel } from '../panels/SettingsPanel.tsx';
import { DrawingsPanel } from '../panels/DrawingsPanel.tsx';
import { ReplayPanel } from '../panels/ReplayPanel.tsx';
import { NewsPanel } from '../news/NewsPanel.tsx';
import { ResearchPanel } from '../research/ResearchPanel.tsx';
import type { IconName } from '../kit.tsx';

export interface PanelTab {
  id: PanelId;
  label: string;
  title: string;
  icon: IconName;
  component: ComponentType;
}

export const PANEL_TABS: PanelTab[] = [
  { id: 'replay', label: 'Replay', title: 'Historical bar replay and its integrity rules', icon: 'play', component: ReplayPanel },
  { id: 'news', label: 'News', title: 'Economic calendar: import, explore and filter releases', icon: 'layers', component: NewsPanel },
  { id: 'research', label: 'Research', title: 'Historical news reaction research and the news backtester', icon: 'layers', component: ResearchPanel },
  { id: 'objects', label: 'Objects', title: 'Drawings on this chart', icon: 'layers', component: DrawingsPanel },
  { id: 'settings', label: 'Settings', title: 'Chart, storage and diagnostics', icon: 'settings', component: SettingsPanel },
];
