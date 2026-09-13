/** Panel registry for the right rail. Subsystems append their tab here. */

import type { ComponentType } from 'react';
import type { PanelId } from '../../core/app/state.ts';
import { SettingsPanel } from '../panels/SettingsPanel.tsx';
import { DrawingsPanel } from '../panels/DrawingsPanel.tsx';
import type { IconName } from '../kit.tsx';

export interface PanelTab {
  id: PanelId;
  label: string;
  title: string;
  icon: IconName;
  component: ComponentType;
}

export const PANEL_TABS: PanelTab[] = [
  { id: 'objects', label: 'Objects', title: 'Drawings on this chart', icon: 'layers', component: DrawingsPanel },
  { id: 'settings', label: 'Settings', title: 'Chart, storage and diagnostics', icon: 'settings', component: SettingsPanel },
];
