/**
 * Manual trade strip. It never invents a fill: BUY/SELL arm a click on the chart,
 * the click records the bar under the pointer, and a market entry is defined as
 * that bar's close. CLOSE acts on the oldest open position, so nothing can be
 * exited into data the replay has not shown yet.
 */

import { useState } from 'react';
import { Btn, Chip } from '../kit.tsx';
import { tradeController } from '../../core/backtest/controller.ts';
import { armTrade } from '../../core/app/modes.ts';
import { useBacktest } from '../../core/backtest/store.ts';
import { useTradeResults } from '../../core/backtest/hooks.ts';
import { useApp } from '../../core/app/state.ts';
import { formatPips, pipSizeFromDecimals } from '../../core/util/pips.ts';

function toggleArm(next: Parameters<typeof armTrade>[0] & object): void {
  const current = tradeController.currentArm();
  const same =
    current !== null &&
    current.mode === next.mode &&
    (next.mode === 'close' || (current.mode === 'open' && current.side === next.side && current.kind === next.kind));
  armTrade(same ? null : next);
}

export function TradeToolbar(): React.ReactElement {
  const account = useBacktest((s) => s.account);
  const replay = useApp((s) => s.replay);
  const fixtureMode = useApp((s) => s.fixtureMode);
  const results = useTradeResults();
  const [kind, setKind] = useState<'market' | 'limit'>('market');
  const arm = tradeController.currentArm();
  const open = results.filter((r) => r.status === 'open');
  const pending = results.filter((r) => r.status === 'pending');
  const floating = open.reduce((acc, r) => acc + (Number.isFinite(r.unrealizedMoney) ? r.unrealizedMoney : 0), 0);
  const pip = pipSizeFromDecimals(account.decimals);
  const ghost = tradeController.currentGhost();
  const riskPips = ghost && ghost.stop !== null ? Math.abs(ghost.price - ghost.stop) / pip : null;
  const rewardPips = ghost && ghost.target !== null ? Math.abs(ghost.target - ghost.price) / pip : null;
  const armedSide = arm?.mode === 'open' ? arm.side : null;

  return (
    <div className="trade-bar" onPointerDown={(e) => e.stopPropagation()}>
      <div className="row" style={{ gap: 1 }}>
        <Btn
          size="xs"
          variant={armedSide === 'buy' ? 'primary' : 'default'}
          active={armedSide === 'buy'}
          tip="Arm a buy entry, then click the bar on the chart (B)"
          onClick={() => toggleArm({ mode: 'open', side: 'buy', kind })}
        >
          Buy
        </Btn>
        <Btn
          size="xs"
          variant={armedSide === 'sell' ? 'primary' : 'default'}
          active={armedSide === 'sell'}
          tip="Arm a sell entry, then click the chart (S)"
          onClick={() => toggleArm({ mode: 'open', side: 'sell', kind })}
        >
          Sell
        </Btn>
        <Btn
          size="xs"
          active={arm?.mode === 'close'}
          tip="Arm a close, then click the bar to exit at. C closes the oldest open position at the newest revealed bar"
          onClick={() => toggleArm({ mode: 'close' })}
          disabled={open.length === 0}
        >
          Close
        </Btn>
      </div>
      <Btn
        size="xs"
        tip={
          kind === 'market'
            ? 'Market: fills at the close of the clicked bar. Click to switch to a limit order at the pointer price'
            : 'Limit: fills only when a revealed bar reaches the price. Until then it stays an order, never a trade'
        }
        active={kind === 'limit'}
        onClick={() => setKind(kind === 'market' ? 'limit' : 'market')}
      >
        {kind}
      </Btn>
      {riskPips !== null || rewardPips !== null ? (
        <span className="trade-risk mono" title="Risk and reward implied by the levels shown on the chart">
          {riskPips !== null ? `risk ${formatPips(riskPips, 1)}` : 'risk —'}
          {rewardPips !== null ? ` / reward ${formatPips(rewardPips, 1)}` : ' / reward —'}
          {riskPips && rewardPips ? ` · R ${(rewardPips / riskPips).toFixed(2)}` : ''}
        </span>
      ) : null}
      {open.length > 0 ? (
        <Chip tone={floating >= 0 ? 'bull' : 'bear'} title="Floating result of open positions, marked at the newest revealed bar">
          {open.length} open · {floating >= 0 ? '+' : '−'}
          {Math.abs(floating).toFixed(2)} {account.currency}
        </Chip>
      ) : null}
      {pending.length > 0 ? (
        <Chip tone="warn" title="Limit orders no revealed bar has reached — excluded from every statistic">
          {pending.length} unfilled
        </Chip>
      ) : null}
      {replay.active ? (
        <span className="dim mono" style={{ fontSize: 10 }} title="Entries can only be placed on revealed bars">
          replay #{replay.cursor + 1}
        </span>
      ) : (
        <span className="dim" style={{ fontSize: 10 }} title="No replay running: entries land on the newest bar of the dataset">
          no replay
        </span>
      )}
      {fixtureMode ? (
        <Chip tone="warn" title="The open dataset is a synthetic fixture: these results verify the mechanics, they are not market evidence">
          fixture
        </Chip>
      ) : null}
      {arm ? (
        <Btn size="xs" tip="Disarm (Esc)" onClick={() => tradeController.cancel()}>
          Disarm
        </Btn>
      ) : null}
    </div>
  );
}
