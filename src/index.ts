export { ContextOptimizer } from './optimizer';

// Types
export type {
  Priority,
  DropStrategy,
  Placement,
  Tokenizer,
  OptimizerConfig,
  AddOptions,
  ContextItem,
  ContextSource,
  PackResult,
  PackedItem,
  Stats,
  SourceStats,
  Warning,
  DroppedItem,
  CostEstimate,
} from './types';

// Utilities — exposed for advanced usage
export { estimateTokens } from './measure/heuristic';
export { DefaultTokenizer } from './measure/tokenizer';
export { scorePriority } from './score/priority';
export { applyRecencyBias } from './score/recency';
export { greedyPack } from './pack/greedy';
export { enforceConstraints } from './pack/constraints';
export type { Constraint } from './pack/constraints';
export { applyPlacement } from './pack/placement';
export { truncateToTokens } from './compress/truncate';
export { estimateCost } from './report/cost';
