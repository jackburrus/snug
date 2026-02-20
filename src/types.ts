/** Priority levels for context items. */
export type Priority = 'required' | 'high' | 'medium' | 'low';

/** Strategy for handling items that don't fit the budget. */
export type DropStrategy = 'relevance' | 'oldest' | 'none';

/** Position in the packed context (for lost-in-the-middle optimization). */
export type Placement = 'beginning' | 'middle' | 'end';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/** Interface for custom tokenizers. Implement this to use tiktoken, etc. */
export interface Tokenizer {
  count(text: string): number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface OptimizerConfig {
  /** Model identifier (used for cost estimation and context window defaults). */
  model: string;
  /** Total context window size in tokens. */
  contextWindow: number;
  /** Tokens to reserve for the model's output. Defaults to 4096. */
  reserveOutput?: number;
  /** Optional custom tokenizer. Falls back to a heuristic estimator. */
  tokenizer?: Tokenizer;
  /**
   * Custom pricing for cost estimation. Overrides the built-in pricing table.
   * Useful for fine-tuned models, private deployments, or when prices change.
   */
  pricing?: {
    /** Cost in USD per 1 million input tokens. */
    inputPer1M: number;
    /** Provider name (e.g. 'anthropic', 'openai'). Defaults to 'custom'. */
    provider?: string;
  };
}

// ---------------------------------------------------------------------------
// Adding sources
// ---------------------------------------------------------------------------

export interface AddOptions {
  /** Priority tier. 'required' items are always included. */
  priority: Priority;
  /**
   * How to handle items that don't fit the budget.
   *
   * - `'relevance'` (default) — drop lowest-scored items first.
   * - `'oldest'` — drop oldest items first (applies recency bias so newer items
   *   score higher). Good for conversation history.
   * - `'none'` — never drop items from this source. All items are treated as
   *   required for packing purposes.
   */
  dropStrategy?: DropStrategy;
  /** For ordered sources (history): keep the last N items as required. */
  keepLast?: number;
  /**
   * Group items into conversation turns before packing.
   *
   * - `'turn'` — Group consecutive messages into turns. A new turn starts at
   *   each `role: 'user'` message. Each turn becomes a single ContextItem that
   *   is packed/dropped atomically. `keepLast` counts turns, not messages.
   *
   * Items without `role` fields are left ungrouped.
   */
  groupBy?: 'turn';
  /**
   * Pin items from this source to the beginning or end of the packed context.
   *
   * - `'beginning'` — place before floating items (good for system prompts,
   *   critical instructions).
   * - `'end'` — place after floating items (good for conversation history,
   *   recent context).
   *
   * Items without a position are "floating" and arranged using the
   * lost-in-the-middle optimization (highest-scored at edges, lowest in middle).
   */
  position?: 'beginning' | 'end';
  /** Custom scoring function. Receives each item and the query. */
  scorer?: (item: ContextItem, query: string) => number;
  /**
   * Dependency constraints: if item A is included, item B must be too.
   *
   * Keys are item IDs in this source, values are item IDs that must be
   * co-included (from any source). If the dependency can't fit in the budget,
   * the triggering item is removed instead.
   *
   * Example: `{ 'tools_search': 'examples_search_demo' }`
   */
  requires?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Internal items
// ---------------------------------------------------------------------------

export interface ContextItem {
  /** Unique identifier (e.g. "tools_search" or "history_3"). */
  id: string;
  /** Source name this item belongs to. */
  source: string;
  /** String representation of the content (used for token counting). */
  content: string;
  /** Original value as passed to add(). Preserved for output. */
  value: unknown;
  /** Token count. */
  tokens: number;
  /** Priority tier. */
  priority: Priority;
  /** Computed relevance score. */
  score: number;
  /** Original position index within its source. */
  index: number;
  /** Placement hint: pin to beginning or end, or float (default). */
  position?: 'beginning' | 'end';
  /** Message role (e.g. 'user', 'assistant', 'system'). Extracted from input objects. */
  role?: string;
}

/** A registered context source. */
export interface ContextSource {
  name: string;
  items: ContextItem[];
  options: AddOptions;
}

// ---------------------------------------------------------------------------
// Pack result
// ---------------------------------------------------------------------------

export interface PackResult {
  /** Ordered items that fit within the budget. */
  items: PackedItem[];
  /** Detailed statistics about the packing decision. */
  stats: Stats;
  /** Actionable warnings. */
  warnings: Warning[];
  /** Items that were excluded. */
  dropped: DroppedItem[];
}

export interface PackedItem {
  id: string;
  source: string;
  content: string;
  /** Original value as passed to add(). */
  value: unknown;
  tokens: number;
  score: number;
  placement: Placement;
  /** Message role (e.g. 'user', 'assistant', 'system'). Present when the input had a `role` field. */
  role?: string;
}

// ---------------------------------------------------------------------------
// Stats & reporting
// ---------------------------------------------------------------------------

export interface Stats {
  totalTokens: number;
  budget: number;
  utilization: number;
  estimatedCost?: CostEstimate;
  breakdown: Record<string, SourceStats>;
}

export interface SourceStats {
  tokens: number;
  items: number;
  dropped?: number;
  reason?: string;
}

export interface Warning {
  type: string;
  message: string;
}

export interface DroppedItem {
  source: string;
  id: string;
  tokens: number;
  score: number;
  reason: string;
}

export interface CostEstimate {
  input: string;
  provider: string;
}
