/**
 * Left rail: the local data library and the watchlist.
 *
 * Datasets are stored in IndexedDB on import; this panel only lists ids/metadata
 * and asks the registry to load payloads on demand.
 */

import { useEffect, useMemo, useState } from 'react';
import { Btn, Icon, InlineEdit, Empty } from '../kit.tsx';
import { appStore, defaultWatchItem, persistUiState, pushDiagnostic, useApp, type WatchItem } from '../../core/app/state.ts';
import { datasetRegistry } from '../../core/data/datasets.ts';
import { deleteDataset, openDataset } from '../../core/app/actions.ts';
import { formatBytes, formatInt } from '../../core/util/format.ts';
import { formatDate } from '../../core/time/tz.ts';

export function LeftRail(): React.ReactElement {
  const [, force] = useState(0);
  const datasets = useMemo(() => datasetRegistry.list(), [force]);
  const watchlist = useApp((s) => s.watchlist);
  const activeId = useApp((s) => s.datasetId);
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);

  useEffect(() => datasetRegistry.subscribe(() => force((v) => v + 1)), []);

  useEffect(() => {
    void datasetRegistry.hydrate().then(() => force((v) => v + 1));
  }, []);

  const filtered = datasets.filter((d) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return d.symbol.toLowerCase().includes(q) || d.fileName.toLowerCase().includes(q) || d.tf.toLowerCase().includes(q);
  });

  const setWatchlist = (next: WatchItem[]): void => {
    appStore.set({ watchlist: next });
    void persistUiState();
  };

  const addToWatch = (symbol: string, datasetId: string | null): void => {
    const clean = symbol.toUpperCase();
    if (watchlist.some((w) => w.symbol === clean)) {
      pushDiagnostic('info', `${clean} is already in the watchlist`);
      return;
    }
    setWatchlist([...watchlist, defaultWatchItem(clean, datasetId)]);
  };

  return (
    <aside className="panel panel-left">
      <div className="panel-header">
        <span className="panel-title">Data library</span>
        <span className="right dim" style={{ fontSize: 10 }}>
          local
        </span>
      </div>
      <div className="panel-section" style={{ paddingBottom: 6 }}>
        <div className="row" style={{ gap: 4 }}>
          <input
            className="input"
            placeholder="Filter symbol, file, timeframe"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Btn
            icon="plus"
            tip="Add a symbol to the watchlist (maps to an imported dataset)"
            onClick={() => {
              const symbol = window.prompt('Watchlist symbol', 'EURUSD');
              if (symbol) addToWatch(symbol, activeId);
            }}
          />
        </div>
      </div>
      <div className="panel-body">
        {filtered.length === 0 ? (
          <Empty>
            No imported datasets yet.
            <br />
            Import a historical OHLC CSV (1-minute to daily) to start.
          </Empty>
        ) : (
          <div className="list">
            {filtered.map((d) => (
              <div
                key={d.id}
                className={activeId === d.id ? 'list-row selected' : 'list-row'}
                onClick={() => void openDataset(d.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && void openDataset(d.id)}
                title={`${d.fileName} · ${d.report.dateFormat ?? 'auto'} · imported ${new Date(d.createdAt).toLocaleString()}`}
              >
                <div style={{ minWidth: 0 }}>
                  <div className="title">
                    {d.label}
                    {d.fileName === 'synthetic-fixture' ? <span className="chip warn" style={{ marginLeft: 6 }}>synthetic</span> : null}
                  </div>
                  <div className="sub">
                    {formatInt(d.count)} bars · {formatDate(d.firstTime, d.tz)} → {formatDate(d.lastTime, d.tz)} · {formatBytes(d.bytes)}
                  </div>
                  <div className="sub dim">
                    {d.report.rejected > 0 ? `${formatInt(d.report.rejected)} rejected rows · ` : ''}
                    {d.report.gapCount > 0 ? `${formatInt(d.report.gapCount)} gaps · ` : ''}
                    {d.tz}
                  </div>
                </div>
                <div className="row" style={{ gap: 2 }}>
                  <Btn
                    size="xs"
                    icon="star"
                    tip="Add to watchlist"
                    onClick={(e) => {
                      e.stopPropagation();
                      addToWatch(d.symbol, d.id);
                    }}
                  />
                  <Btn
                    size="xs"
                    icon="trash"
                    tip="Delete dataset from local library"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm(`Delete ${d.label}? The CSV file itself is untouched.`)) void deleteDataset(d.id);
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="panel-section">
          <h4 className="section-title">Watchlist</h4>
          {watchlist.length === 0 ? (
            <div className="note small dim">
              Watchlist entries bind a symbol to an imported dataset. No live prices by design.
            </div>
          ) : (
            <div className="list" style={{ gap: 1 }}>
              {watchlist.map((w, i) => {
                const bound = w.datasetId ? datasetRegistry.get(w.datasetId) : null;
                return (
                  <div
                    key={w.id}
                    className={bound && activeId === bound.id ? 'list-row selected' : 'list-row'}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (bound) void openDataset(bound.id, { tf: w.tf });
                      else pushDiagnostic('warn', `${w.symbol} has no imported dataset attached`);
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && bound && void openDataset(bound.id, { tf: w.tf })}
                    title={bound ? `${bound.fileName}` : 'no dataset attached'}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div className="title">
                        <span
                          style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}
                          onDoubleClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setRenaming(w.id);
                          }}
                          title="Double-click to rename"
                        >
                          <Icon name="star" size={10} filled={w.favorite} />
                          {renaming === w.id ? (
                            <InlineEdit
                              value={w.label}
                              onSave={(v) => {
                                setWatchlist(watchlist.map((x) => (x.id === w.id ? { ...x, label: v } : x)));
                                setRenaming(null);
                              }}
                            />
                          ) : (
                            w.label
                          )}
                        </span>
                      </div>
                      <div className="sub">{bound ? `${bound.tf} · ${formatInt(bound.count)} bars` : 'unbound'}</div>
                    </div>
                    <div className="row" style={{ gap: 1 }}>
                      <Btn
                        size="xs"
                        icon="star"
                        tip="Favorite"
                        onClick={(e) => {
                          e.stopPropagation();
                          setWatchlist(watchlist.map((x) => (x.id === w.id ? { ...x, favorite: !x.favorite } : x)));
                        }}
                      />
                      <Btn
                        size="xs"
                        icon="chevronDown"
                        tip="Move up / attach dataset"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (i === 0) return;
                          const next = [...watchlist];
                          [next[i - 1], next[i]] = [next[i], next[i - 1]];
                          setWatchlist(next);
                        }}
                      />
                      <Btn
                        size="xs"
                        icon="trash"
                        tip="Remove from watchlist"
                        onClick={(e) => {
                          e.stopPropagation();
                          setWatchlist(watchlist.filter((x) => x.id !== w.id));
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
