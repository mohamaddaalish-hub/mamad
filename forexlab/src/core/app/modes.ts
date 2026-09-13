/**
 * Chart input modes.
 *
 * Only one tool may own the pointer at a time: a drawing tool, a trade entry, or
 * plain navigation. Both the toolbars and the keyboard go through here, so arming
 * one thing always releases the other instead of silently losing the click to the
 * layer that happens to be consulted first.
 */

import { appStore } from './state.ts';
import { drawingController } from '../draw/controller.ts';
import type { DrawingKind } from '../draw/model.ts';
import { tradeController, type TradeArm } from '../backtest/controller.ts';

// Mutual exclusion, wired once so it holds no matter which entry point armed a tool.
tradeController.onArmChange = (arm) => {
  if (arm && drawingController.tool !== null) drawingController.setTool(null);
};
drawingController.onToolChange = (kind) => {
  if (kind !== null && tradeController.isArmed()) tradeController.setArm(null);
};

export function armDrawingTool(kind: DrawingKind | null): void {
  if (kind) tradeController.setArm(null);
  drawingController.setTool(kind);
}

export function toggleDrawingTool(kind: DrawingKind): void {
  const current = appStore.get().tool;
  armDrawingTool(current === kind ? null : kind);
}

export function armTrade(next: Exclude<TradeArm, null> | null): void {
  if (next) {
    if (appStore.get().tool !== null) drawingController.setTool(null);
  }
  if (next === null) {
    tradeController.setArm(null);
    return;
  }
  tradeController.setArm(next);
}
