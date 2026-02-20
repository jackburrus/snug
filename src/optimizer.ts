import type {
  OptimizerConfig,
  AddOptions,
  ContextItem,
  ContextSource,
  PackResult,
  Tokenizer,
} from './types';
import { DefaultTokenizer } from './measure/tokenizer';
import { scorePriority } from './score/priority';
import { applyRecencyBias } from './score/recency';
import { greedyPack } from './pack/greedy';
import { enforceConstraints, type Constraint } from './pack/constraints';
import { applyPlacement } from './pack/placement';
import { buildStats } from './report/stats';
import { detectWarnings } from './report/warnings';

const DEFAULT_RESERVE_OUTPUT = 4096;

export class ContextOptimizer {
  private config: OptimizerConfig;
  private tokenizer: Tokenizer;
  private sources: Map<string, ContextSource> = new Map();

  constructor(config: OptimizerConfig) {
    this.config = config;
    this.tokenizer = config.tokenizer ?? new DefaultTokenizer();
  }

  /**
   * Register a context source.
   *
   * @param source  - Identifier for this source (e.g. 'system', 'tools', 'history')
   * @param content - The content. Strings become one item; arrays become multiple
   *                  independently-scored items. Objects are JSON-stringified.
   * @param options - Priority, drop/compress strategies, etc.
   *
   * Calling `add()` with the same source name replaces the previous registration.
   */
  add(
    source: string,
    content: string | string[] | object | object[],
    options: AddOptions,
  ): this {
    const items = this.normalizeContent(source, content, options);
    this.sources.set(source, { name: source, items, options });
    return this;
  }

  /**
   * Remove a previously registered source.
   */
  remove(source: string): this {
    this.sources.delete(source);
    return this;
  }

  /**
   * Remove all registered sources.
   */
  clear(): this {
    this.sources.clear();
    return this;
  }

  /**
   * Pack the registered context into an optimized arrangement.
   *
   * @param query - Optional user query. Used for relevance scoring and
   *                included as a required item at the end of the output.
   * @returns PackResult with ordered items, stats, warnings, and dropped items.
   */
  pack(query?: string): PackResult {
    const budget =
      this.config.contextWindow -
      (this.config.reserveOutput ?? DEFAULT_RESERVE_OUTPUT);

    // Collect and score all items (cloned — source items are never mutated)
    const allItems = this.collectAndScore(query);

    // Add query as a required item if provided
    if (query) {
      allItems.push({
        id: 'query_0',
        source: 'query',
        content: query,
        value: query,
        tokens: this.tokenizer.count(query),
        priority: 'required',
        score: Infinity,
        index: 0,
        position: 'end',
      });
    }

    // Greedy knapsack packing
    const { included, dropped } = greedyPack(allItems, budget);

    // Enforce dependency constraints
    const constraints = this.collectConstraints();
    const { added, removed } = enforceConstraints(
      included,
      dropped.map(d => allItems.find(i => i.id === d.id)!).filter(Boolean),
      constraints,
      budget,
    );

    // Update dropped list: remove items that were added by constraints, add items removed
    const addedIds = new Set(added.map(i => i.id));
    const finalDropped = [
      ...dropped.filter(d => !addedIds.has(d.id)),
      ...removed.map(i => ({
        source: i.source,
        id: i.id,
        tokens: i.tokens,
        score: i.score,
        reason: 'constraint dependency unavailable',
      })),
    ];

    // Position-aware placement (lost-in-the-middle optimization)
    const placed = applyPlacement(included);

    // Build report
    const stats = buildStats(placed, finalDropped, budget, this.config);
    const warnings = detectWarnings(placed, finalDropped, budget);

    return { items: placed, stats, warnings, dropped: finalDropped };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private normalizeContent(
    source: string,
    content: string | string[] | object | object[],
    options: AddOptions,
  ): ContextItem[] {
    const contentArray = Array.isArray(content) ? content : [content];

    // Build individual items with role extraction
    const items: ContextItem[] = [];
    for (let i = 0; i < contentArray.length; i++) {
      const raw = contentArray[i]!;
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      const itemId = this.deriveItemId(source, raw, i);

      // Extract role from objects that have a role field
      let role: string | undefined;
      if (typeof raw === 'object' && raw !== null) {
        const obj = raw as Record<string, unknown>;
        if (typeof obj['role'] === 'string') {
          role = obj['role'];
        }
      }

      items.push({
        id: itemId,
        source,
        content: text,
        value: raw,
        tokens: this.tokenizer.count(text),
        priority: options.priority,
        score: 0,
        index: i,
        position: options.position,
        role,
      });
    }

    // Group into conversation turns if requested
    if (options.groupBy === 'turn') {
      const grouped = this.groupIntoTurns(source, items, options);

      // Promote last N turns to 'required' if keepLast is set
      if (options.keepLast != null && options.keepLast > 0) {
        const start = Math.max(0, grouped.length - options.keepLast);
        for (let i = start; i < grouped.length; i++) {
          grouped[i]!.priority = 'required';
        }
      }

      return grouped;
    }

    // Promote last N items to 'required' if keepLast is set
    if (options.keepLast != null && options.keepLast > 0) {
      const start = Math.max(0, items.length - options.keepLast);
      for (let i = start; i < items.length; i++) {
        items[i]!.priority = 'required';
      }
    }

    return items;
  }

  /**
   * Group items into conversation turns. A new turn starts at each `role: 'user'`
   * message. Items without role fields are left ungrouped.
   */
  private groupIntoTurns(
    source: string,
    items: ContextItem[],
    options: AddOptions,
  ): ContextItem[] {
    // If no items have role fields, groupBy is a no-op
    const hasRoles = items.some(item => item.role != null);
    if (!hasRoles) return items;

    const turns: ContextItem[][] = [];
    let currentTurn: ContextItem[] = [];

    for (const item of items) {
      if (item.role === 'user' && currentTurn.length > 0) {
        turns.push(currentTurn);
        currentTurn = [];
      }
      currentTurn.push(item);
    }
    if (currentTurn.length > 0) {
      turns.push(currentTurn);
    }

    // Convert each turn group into a single ContextItem
    return turns.map((turnItems, turnIndex) => {
      const content = turnItems.map(item => item.content).join('\n');
      const value = turnItems.map(item => item.value);
      const tokens = turnItems.reduce((sum, item) => sum + item.tokens, 0);

      return {
        id: `${source}_turn_${turnIndex}`,
        source,
        content,
        value,
        tokens,
        priority: options.priority,
        score: 0,
        index: turnIndex,
        position: options.position,
        // Turns have multiple roles, so role is undefined
      };
    });
  }

  private deriveItemId(source: string, raw: unknown, index: number): string {
    if (typeof raw === 'object' && raw !== null) {
      const obj = raw as Record<string, unknown>;
      const name = obj['name'] ?? obj['id'];
      if (typeof name === 'string' || typeof name === 'number') {
        return `${source}_${name}`;
      }
    }
    return `${source}_${index}`;
  }

  private collectConstraints(): Constraint[] {
    const constraints: Constraint[] = [];
    for (const [, source] of this.sources) {
      if (!source.options.requires) continue;
      for (const [ifIncluded, thenRequire] of Object.entries(source.options.requires)) {
        constraints.push({ ifIncluded, thenRequire });
      }
    }
    return constraints;
  }

  /**
   * Clone source items and apply scoring.
   *
   * Items are cloned so that pack() is pure — calling it multiple times
   * with different queries produces correct, independent results.
   */
  private collectAndScore(query?: string): ContextItem[] {
    const allItems: ContextItem[] = [];

    for (const [, source] of this.sources) {
      // Clone items so scoring never mutates the registered sources
      const cloned = source.items.map(item => ({ ...item }));

      // dropStrategy: 'none' — treat all items as required (never dropped)
      if (source.options.dropStrategy === 'none') {
        for (const item of cloned) {
          item.priority = 'required';
        }
      }

      // Assign base score from priority
      for (const item of cloned) {
        item.score = scorePriority(item.priority);
      }

      // dropStrategy: 'oldest' — apply recency bias so older items drop first
      if (source.options.dropStrategy === 'oldest') {
        applyRecencyBias(cloned);
      }

      // Apply custom scorer if provided
      if (source.options.scorer && query) {
        for (const item of cloned) {
          if (item.priority !== 'required') {
            item.score = source.options.scorer(item, query);
          }
        }
      }

      allItems.push(...cloned);
    }

    return allItems;
  }
}
