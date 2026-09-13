/**
 * The chart engine handle, kept in its own module so core layers (replay gate,
 * overlays, analytics) can reach the live engine without importing the app
 * actions module — which would create a cycle.
 */

import type { ChartEngine } from './engine.ts';

export const chartHost: { engine: ChartEngine | null } = { engine: null };
