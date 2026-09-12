/**
 * Right-hand research panel. Tabs are contributed by subsystems (settings,
 * drawings, backtest, news, research) in `panelTabs.tsx`.
 */

import { Btn, Icon, Tabs } from '../kit.tsx';
import { appStore, useApp, type PanelId } from '../../core/app/state.ts';
import { PANEL_TABS } from './panelTabs.tsx';

export function RightPanel(): React.ReactElement {
  const panel = useApp((s) => s.panel);
  const active = panel ?? 'settings';
  return (
    <aside className="panel panel-right">
      <div className="panel-header" style={{ paddingLeft: 6 }}>
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <Tabs
            value={active}
            onChange={(id) => appStore.set({ panel: id as PanelId })}
            items={PANEL_TABS.map((t) => ({ id: t.id, label: t.label, title: t.title }))}
          />
        </div>
        <Btn size="xs" icon="close" tip="Hide panel" onClick={() => appStore.set({ rightOpen: false })} />
      </div>
      {PANEL_TABS.map((tab) => {
        if (tab.id !== active) return null;
        const Component = tab.component;
        return (
          <div key={tab.id} className="panel-body" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Component />
          </div>
        );
      })}
      {PANEL_TABS.length === 0 ? (
        <div className="empty">
          <Icon name="settings" />
        </div>
      ) : null}
    </aside>
  );
}
