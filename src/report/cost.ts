import type { CostEstimate } from '../types';

/**
 * Estimate input cost for a given token count.
 *
 * Returns a cost estimate only when custom pricing is provided via
 * `OptimizerConfig.pricing`. Returns undefined otherwise.
 */
export function estimateCost(
  tokens: number,
  _model: string,
  customPricing?: { inputPer1M: number; provider?: string },
): CostEstimate | undefined {
  if (!customPricing) return undefined;

  const cost = (tokens / 1_000_000) * customPricing.inputPer1M;
  return {
    input: `$${cost.toFixed(4)}`,
    provider: customPricing.provider ?? 'custom',
  };
}
