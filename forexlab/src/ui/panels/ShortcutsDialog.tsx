/** Shortcut sheet — grouped, no marketing copy, one place to read the map. */

import { Modal } from '../kit.tsx';
import { SHORTCUTS, closeDialog } from '../../core/app/dialogs.ts';

export function ShortcutsDialog(): React.ReactElement {
  const scopes: string[] = [];
  for (const s of SHORTCUTS) if (!scopes.includes(s.scope)) scopes.push(s.scope);
  return (
    <Modal title="Keyboard shortcuts" subtitle="shown in every tooltip as well" onClose={closeDialog} narrow>
      {scopes.map((scope) => (
        <div key={scope} style={{ marginBottom: 10 }}>
          <h4 className="section-title">{scope}</h4>
          <table className="table compact">
            <tbody>
              {SHORTCUTS.filter((s) => s.scope === scope).map((s) => (
                <tr key={`${s.scope}-${s.keys}`}>
                  <td style={{ width: 150 }}>
                    <kbd>{s.keys}</kbd>
                  </td>
                  <td>{s.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </Modal>
  );
}
