import type {
  PackedItem,
  DroppedItem,
  Stats,
  SourceStats,
  OptimizerConfig,
} from '../types';
import { estimateCost } from './cost';

/** Build a Stats object from packing decisions. */
export function buildStats(
  included: PackedItem[],
  dropped: DroppedItem[],
  budget: number,
  config: OptimizerConfig,
): Stats {
  const breakdown: Record<string, SourceStats> = {};

  // Tally included items
  for (const item of included) {
    const entry = breakdown[item.source] ?? { tokens: 0, items: 0 };
    entry.tokens += item.tokens;
    entry.items += 1;
    breakdown[item.source] = entry;
  }

  // Tally dropped items
  for (const item of dropped) {
    const entry = breakdown[item.source] ?? { tokens: 0, items: 0 };
    entry.dropped = (entry.dropped ?? 0) + 1;
    if (!entry.reason) entry.reason = item.reason;
    breakdown[item.source] = entry;
  }

  const totalTokens = included.reduce((sum, i) => sum + i.tokens, 0);

  return {
    totalTokens,
    budget,
    utilization: budget > 0 ? totalTokens / budget : 0,
    estimatedCost: estimateCost(totalTokens, config.model, config.pricing),
    breakdown,
  };
}
