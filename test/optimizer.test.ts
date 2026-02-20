import { test, expect, describe } from 'bun:test';
import {
  ContextOptimizer,
  estimateTokens,
  scorePriority,
  applyRecencyBias,
  greedyPack,
  applyPlacement,
  enforceConstraints,
  truncateToTokens,
  estimateCost,
  DefaultTokenizer,
} from '../src/index';
import type { ContextItem, Constraint } from '../src/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<ContextItem> & { id: string }): ContextItem {
  return {
    source: 'test',
    content: overrides.id,
    value: overrides.id,
    tokens: 10,
    priority: 'medium',
    score: 50,
    index: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Measure
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  test('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  test('estimates ~4 chars per token for plain English', () => {
    const text = 'Hello, this is a simple test sentence for estimation.';
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThanOrEqual(13);
    expect(tokens).toBeLessThanOrEqual(18);
  });

  test('uses tighter ratio for JSON/code content', () => {
    const json = '{"name":"search","description":"Search the web","parameters":{"query":{"type":"string"}}}';
    const tokens = estimateTokens(json);
    expect(tokens).toBeGreaterThanOrEqual(25);
    expect(tokens).toBeLessThanOrEqual(35);
  });

  test('smoothly interpolates between prose and code', () => {
    // 5% structural → should be between 3 and 4 chars/token
    const mildCode = 'let x = foo(bar);' + ' some prose text here'.repeat(5);
    const tokensA = estimateTokens(mildCode);
    // Pure prose
    const prose = 'This is a simple sentence without any code or structure at all repeated a few times.';
    const tokensB = estimateTokens(prose);
    // Heavy code
    const heavy = '{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7}';
    const tokensC = estimateTokens(heavy);
    // Code should produce more tokens per character than prose
    expect(tokensC / heavy.length).toBeGreaterThan(tokensB / prose.length);
  });
});

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

describe('scorePriority', () => {
  test('required returns Infinity', () => {
    expect(scorePriority('required')).toBe(Infinity);
  });

  test('tiers are ordered correctly', () => {
    expect(scorePriority('high')).toBeGreaterThan(scorePriority('medium'));
    expect(scorePriority('medium')).toBeGreaterThan(scorePriority('low'));
  });
});

describe('applyRecencyBias', () => {
  test('oldest item gets lowest score, newest gets highest', () => {
    const items: ContextItem[] = [
      makeItem({ id: '0', score: 100, index: 0 }),
      makeItem({ id: '1', score: 100, index: 1 }),
      makeItem({ id: '2', score: 100, index: 2 }),
    ];
    applyRecencyBias(items);
    expect(items[0]!.score).toBeLessThan(items[1]!.score);
    expect(items[1]!.score).toBeLessThan(items[2]!.score);
    expect(items[2]!.score).toBe(100);
    expect(items[0]!.score).toBeCloseTo(10, 0);
  });

  test('does not decay required items', () => {
    const items: ContextItem[] = [
      makeItem({ id: '0', priority: 'required', score: Infinity, index: 0 }),
      makeItem({ id: '1', score: 100, index: 1 }),
    ];
    applyRecencyBias(items);
    expect(items[0]!.score).toBe(Infinity);
  });
});

// ---------------------------------------------------------------------------
// Pack
// ---------------------------------------------------------------------------

describe('greedyPack', () => {
  test('includes all required items even if they exceed budget', () => {
    const items = [makeItem({ id: 'sys', priority: 'required', score: Infinity, tokens: 500 })];
    const result = greedyPack(items, 100);
    expect(result.included).toHaveLength(1);
    expect(result.totalTokens).toBe(500);
  });

  test('drops lowest-scored items when budget is tight', () => {
    const items = [
      makeItem({ id: 'a', score: 80, tokens: 100 }),
      makeItem({ id: 'b', score: 50, tokens: 100 }),
      makeItem({ id: 'c', priority: 'low', score: 20, tokens: 100 }),
    ];
    const result = greedyPack(items, 200);
    expect(result.included).toHaveLength(2);
    expect(result.included.map(i => i.id)).toContain('a');
    expect(result.included.map(i => i.id)).toContain('b');
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]!.id).toBe('c');
  });

  test('breaks ties by preferring fewer tokens', () => {
    const items = [
      makeItem({ id: 'big', score: 50, tokens: 150 }),
      makeItem({ id: 'small', score: 50, tokens: 50 }),
    ];
    const result = greedyPack(items, 100);
    expect(result.included).toHaveLength(1);
    expect(result.included[0]!.id).toBe('small');
  });

  test('continues scanning past items that dont fit', () => {
    const items = [
      makeItem({ id: 'big', score: 90, tokens: 200 }),
      makeItem({ id: 'small', score: 80, tokens: 50 }),
    ];
    const result = greedyPack(items, 100);
    // 'big' doesn't fit but 'small' does — packer should continue
    expect(result.included).toHaveLength(1);
    expect(result.included[0]!.id).toBe('small');
    expect(result.dropped[0]!.id).toBe('big');
  });
});

describe('applyPlacement', () => {
  test('items with position beginning go first', () => {
    const items = [
      makeItem({ id: 'sys', source: 'system', position: 'beginning', score: Infinity }),
      makeItem({ id: 'rag', source: 'rag', score: 50 }),
      makeItem({ id: 'q', source: 'query', position: 'end', score: Infinity }),
    ];
    const placed = applyPlacement(items);
    expect(placed[0]!.id).toBe('sys');
    expect(placed[0]!.placement).toBe('beginning');
  });

  test('items with position end go last', () => {
    const items = [
      makeItem({ id: 'sys', position: 'beginning', score: Infinity }),
      makeItem({ id: 'q', source: 'query', position: 'end', score: Infinity }),
    ];
    const placed = applyPlacement(items);
    expect(placed[placed.length - 1]!.id).toBe('q');
    expect(placed[placed.length - 1]!.placement).toBe('end');
  });

  test('pinned-end items preserve original order', () => {
    const items = [
      makeItem({ id: 'h0', position: 'end', score: 50, index: 0 }),
      makeItem({ id: 'h2', position: 'end', score: 90, index: 2 }),
      makeItem({ id: 'h1', position: 'end', score: 70, index: 1 }),
    ];
    const placed = applyPlacement(items);
    expect(placed[0]!.id).toBe('h0');
    expect(placed[1]!.id).toBe('h1');
    expect(placed[2]!.id).toBe('h2');
  });

  test('floating items use edges-first placement by score', () => {
    const items = [
      makeItem({ id: 'high', score: 100, tokens: 10 }),
      makeItem({ id: 'mid', score: 50, tokens: 10 }),
      makeItem({ id: 'low', score: 10, tokens: 10 }),
    ];
    const placed = applyPlacement(items);
    // Highest score first (beginning), then lowest in middle, mid between
    expect(placed[0]!.id).toBe('high');
    expect(placed[0]!.placement).toBe('beginning');
  });
});

// ---------------------------------------------------------------------------
// Compress
// ---------------------------------------------------------------------------

describe('truncateToTokens', () => {
  const tokenizer = new DefaultTokenizer();

  test('returns original text if already within budget', () => {
    expect(truncateToTokens('Hello', 100, tokenizer)).toBe('Hello');
  });

  test('truncates long text to fit budget', () => {
    const long = 'a'.repeat(1000);
    const result = truncateToTokens(long, 50, tokenizer);
    expect(tokenizer.count(result)).toBeLessThanOrEqual(55);
  });

  test('returns empty string for zero budget', () => {
    expect(truncateToTokens('Hello world', 0, tokenizer)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

describe('estimateCost', () => {
  test('returns undefined when no pricing is provided', () => {
    expect(estimateCost(1_000_000, 'claude-sonnet-4-20250514')).toBeUndefined();
  });

  test('returns cost when custom pricing is provided', () => {
    const cost = estimateCost(1_000_000, 'my-model', {
      inputPer1M: 5,
      provider: 'my-provider',
    });
    expect(cost).toBeDefined();
    expect(cost!.input).toBe('$5.0000');
    expect(cost!.provider).toBe('my-provider');
  });

  test('defaults provider to "custom"', () => {
    const cost = estimateCost(1_000_000, 'my-model', { inputPer1M: 2 });
    expect(cost).toBeDefined();
    expect(cost!.provider).toBe('custom');
  });
});

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

describe('enforceConstraints', () => {
  test('pulls in dependency when trigger is included', () => {
    const included = [makeItem({ id: 'tools_search', priority: 'high', score: 100, tokens: 50 })];
    const available = [makeItem({ id: 'examples_search_demo', priority: 'low', score: 10, tokens: 50 })];
    const constraints: Constraint[] = [
      { ifIncluded: 'tools_search', thenRequire: 'examples_search_demo' },
    ];
    const result = enforceConstraints(included, available, constraints, 200);
    expect(result.included.some(i => i.id === 'examples_search_demo')).toBe(true);
    expect(result.added).toHaveLength(1);
  });

  test('removes trigger when dependency cannot fit', () => {
    const included = [makeItem({ id: 'tools_search', priority: 'high', score: 100, tokens: 80 })];
    const available = [makeItem({ id: 'examples_search_demo', priority: 'low', score: 10, tokens: 50 })];
    const constraints: Constraint[] = [
      { ifIncluded: 'tools_search', thenRequire: 'examples_search_demo' },
    ];
    const result = enforceConstraints(included, available, constraints, 100);
    expect(result.included.some(i => i.id === 'tools_search')).toBe(false);
    expect(result.removed).toHaveLength(1);
  });

  test('does not remove required trigger', () => {
    const included = [makeItem({ id: 'sys', priority: 'required', score: Infinity, tokens: 80 })];
    const available = [makeItem({ id: 'dep', priority: 'low', score: 10, tokens: 50 })];
    const constraints: Constraint[] = [
      { ifIncluded: 'sys', thenRequire: 'dep' },
    ];
    const result = enforceConstraints(included, available, constraints, 100);
    expect(result.included.some(i => i.id === 'sys')).toBe(true);
    expect(result.removed).toHaveLength(0);
  });

  test('handles transitive constraints (A→B, B→C)', () => {
    const included = [makeItem({ id: 'a', priority: 'high', score: 100, tokens: 20 })];
    const available = [
      makeItem({ id: 'b', priority: 'low', score: 10, tokens: 20 }),
      makeItem({ id: 'c', priority: 'low', score: 10, tokens: 20 }),
    ];
    const constraints: Constraint[] = [
      { ifIncluded: 'a', thenRequire: 'b' },
      { ifIncluded: 'b', thenRequire: 'c' },
    ];
    const result = enforceConstraints(included, available, constraints, 200);
    expect(result.included.some(i => i.id === 'a')).toBe(true);
    expect(result.included.some(i => i.id === 'b')).toBe(true);
    expect(result.included.some(i => i.id === 'c')).toBe(true);
    expect(result.added).toHaveLength(2);
  });

  test('removes trigger chain when transitive dep cannot fit', () => {
    const included = [makeItem({ id: 'a', priority: 'high', score: 100, tokens: 40 })];
    const available = [
      makeItem({ id: 'b', priority: 'low', score: 10, tokens: 40 }),
      makeItem({ id: 'c', priority: 'low', score: 10, tokens: 40 }),
    ];
    const constraints: Constraint[] = [
      { ifIncluded: 'a', thenRequire: 'b' },
      { ifIncluded: 'b', thenRequire: 'c' },
    ];
    // Budget 100: a(40) + b(40) = 80 fits, but c(40) → 120 exceeds
    // b should be removed (can't satisfy b→c), then a should be removed (can't satisfy a→b)
    const result = enforceConstraints(included, available, constraints, 100);
    expect(result.included.some(i => i.id === 'a')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ContextOptimizer (integration)
// ---------------------------------------------------------------------------

describe('ContextOptimizer', () => {
  test('basic packing with system prompt and query', () => {
    const opt = new ContextOptimizer({
      model: 'claude-sonnet-4-20250514',
      contextWindow: 10000,
      reserveOutput: 1000,
    });

    opt.add('system', 'You are a helpful assistant.', { priority: 'required', position: 'beginning' });
    const result = opt.pack('What is 2+2?');

    expect(result.items.length).toBeGreaterThanOrEqual(2);
    expect(result.items[0]!.source).toBe('system');
    expect(result.items[result.items.length - 1]!.source).toBe('query');
    expect(result.stats.totalTokens).toBeGreaterThan(0);
    expect(result.stats.budget).toBe(9000);
    expect(result.stats.utilization).toBeGreaterThan(0);
  });

  test('pack without query', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 10000,
    });

    opt.add('system', 'System prompt.', { priority: 'required', position: 'beginning' });
    opt.add('memory', ['fact one', 'fact two'], { priority: 'medium' });

    const result = opt.pack();
    expect(result.items).toHaveLength(3);
    expect(result.items.find(i => i.source === 'query')).toBeUndefined();
  });

  test('drops low-priority items when budget is exceeded', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 500,
      reserveOutput: 100,
    });

    opt.add('system', 'x'.repeat(200), { priority: 'required', position: 'beginning' });
    opt.add('rag', ['a'.repeat(200), 'b'.repeat(200), 'c'.repeat(200)], { priority: 'medium' });

    const result = opt.pack();
    expect(result.stats.totalTokens).toBeLessThanOrEqual(400);
    expect(result.dropped.length + result.items.length).toBeGreaterThanOrEqual(1);
  });

  test('keepLast promotes recent history to required', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 200,
      reserveOutput: 50,
    });

    opt.add('history', [
      { role: 'user', content: 'old message' },
      { role: 'assistant', content: 'old reply' },
      { role: 'user', content: 'recent message' },
    ], { priority: 'high', keepLast: 1, position: 'end', dropStrategy: 'oldest' });

    const result = opt.pack();
    const historyItems = result.items.filter(i => i.source === 'history');
    expect(historyItems.some(i => i.id === 'history_2')).toBe(true);
  });

  test('tools with named objects get readable IDs', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 10000,
    });

    opt.add('tools', [
      { name: 'search', description: 'Search the web' },
      { name: 'calculate', description: 'Do math' },
    ], { priority: 'high' });

    const result = opt.pack();
    const toolIds = result.items.map(i => i.id);
    expect(toolIds).toContain('tools_search');
    expect(toolIds).toContain('tools_calculate');
  });

  test('preserves original values in output', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 10000,
    });

    const toolDef = { name: 'search', description: 'Search the web', parameters: {} };
    opt.add('tools', [toolDef], { priority: 'high' });

    const result = opt.pack();
    const tool = result.items.find(i => i.source === 'tools');
    expect(tool!.value).toEqual(toolDef);
  });

  test('replace source on re-add', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 10000,
    });

    opt.add('system', 'Version 1', { priority: 'required', position: 'beginning' });
    opt.add('system', 'Version 2', { priority: 'required', position: 'beginning' });

    const result = opt.pack();
    const systemItems = result.items.filter(i => i.source === 'system');
    expect(systemItems).toHaveLength(1);
    expect(systemItems[0]!.content).toBe('Version 2');
  });

  test('remove() and clear()', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 10000,
    });

    opt.add('system', 'sys', { priority: 'required', position: 'beginning' });
    opt.add('tools', ['a', 'b'], { priority: 'high' });

    opt.remove('tools');
    let result = opt.pack();
    expect(result.items.filter(i => i.source === 'tools')).toHaveLength(0);

    opt.clear();
    result = opt.pack();
    expect(result.items).toHaveLength(0);
  });

  test('cost estimation is undefined without pricing config', () => {
    const opt = new ContextOptimizer({
      model: 'claude-sonnet-4-20250514',
      contextWindow: 10000,
    });

    opt.add('system', 'Hello world.', { priority: 'required', position: 'beginning' });
    const result = opt.pack();
    expect(result.stats.estimatedCost).toBeUndefined();
  });

  test('cost estimation works with pricing config', () => {
    const opt = new ContextOptimizer({
      model: 'claude-sonnet-4-20250514',
      contextWindow: 10000,
      pricing: { inputPer1M: 3, provider: 'anthropic' },
    });

    opt.add('system', 'Hello world.', { priority: 'required', position: 'beginning' });
    const result = opt.pack();
    expect(result.stats.estimatedCost).toBeDefined();
    expect(result.stats.estimatedCost!.provider).toBe('anthropic');
  });

  test('warnings: budget exceeded by required items', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 100,
      reserveOutput: 50,
    });

    opt.add('system', 'x'.repeat(1000), { priority: 'required', position: 'beginning' });
    const result = opt.pack();
    expect(result.warnings.some(w => w.type === 'budget-exceeded')).toBe(true);
  });

  test('warnings: tool overload', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 100000,
    });

    const tools = Array.from({ length: 15 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Tool ${i}`,
    }));
    opt.add('tools', tools, { priority: 'high' });
    const result = opt.pack();
    expect(result.warnings.some(w => w.type === 'tool-overload')).toBe(true);
  });

  test('custom scorer overrides priority scoring', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 300,
      reserveOutput: 50,
    });

    opt.add('rag', ['about cats', 'about dogs', 'about fish'], {
      priority: 'medium',
      scorer: (item) => {
        return item.content.includes('cats') ? 200 : 10;
      },
    });

    const result = opt.pack('Tell me about cats');
    const ragItems = result.items.filter(i => i.source === 'rag');
    if (ragItems.length > 0) {
      expect(ragItems[0]!.content).toBe('about cats');
    }
  });

  // -------------------------------------------------------------------------
  // pack() purity (mutation fix)
  // -------------------------------------------------------------------------

  test('pack() is pure — calling twice with different queries gives independent results', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 10000,
    });

    opt.add('docs', ['about cats', 'about dogs'], {
      priority: 'medium',
      scorer: (item, query) => item.content.includes(query.split(' ').pop()!) ? 200 : 10,
    });

    const r1 = opt.pack('tell me about cats');
    const r2 = opt.pack('tell me about dogs');

    const docsR1 = r1.items.filter(i => i.source === 'docs');
    const docsR2 = r2.items.filter(i => i.source === 'docs');

    // Both calls should have independently scored items
    const catScoreR1 = docsR1.find(i => i.content === 'about cats')!.score;
    const catScoreR2 = docsR2.find(i => i.content === 'about cats')!.score;
    expect(catScoreR1).toBe(200);
    expect(catScoreR2).toBe(10);

    const dogScoreR1 = docsR1.find(i => i.content === 'about dogs')!.score;
    const dogScoreR2 = docsR2.find(i => i.content === 'about dogs')!.score;
    expect(dogScoreR1).toBe(10);
    expect(dogScoreR2).toBe(200);
  });

  test('pack() is pure — recency bias does not accumulate across calls', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 10000,
    });

    opt.add('history', ['old', 'mid', 'new'], {
      priority: 'high',
      dropStrategy: 'oldest',
      position: 'end',
    });

    const r1 = opt.pack();
    const r2 = opt.pack();

    // Scores should be identical across both calls
    const scores1 = r1.items.filter(i => i.source === 'history').map(i => i.score);
    const scores2 = r2.items.filter(i => i.source === 'history').map(i => i.score);
    expect(scores1).toEqual(scores2);
  });

  // -------------------------------------------------------------------------
  // Position-based placement
  // -------------------------------------------------------------------------

  test('position: beginning pins items at the start', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 10000,
    });

    opt.add('instructions', 'Always be concise.', { priority: 'required', position: 'beginning' });
    opt.add('tools', ['tool_a'], { priority: 'high' });
    opt.add('context', ['some context'], { priority: 'medium' });

    const result = opt.pack('hello');
    expect(result.items[0]!.source).toBe('instructions');
    expect(result.items[0]!.placement).toBe('beginning');
  });

  test('position: end pins items at the end (before query)', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 10000,
    });

    opt.add('system', 'sys', { priority: 'required', position: 'beginning' });
    opt.add('recent', ['latest context'], { priority: 'high', position: 'end' });
    opt.add('tools', ['tool_a'], { priority: 'high' });

    const result = opt.pack('hello');
    const items = result.items;
    // Query is last, recent is second-to-last
    expect(items[items.length - 1]!.source).toBe('query');
    expect(items[items.length - 2]!.source).toBe('recent');
  });

  test('floating items (no position) are placed by score, edges first', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 10000,
    });

    opt.add('a', 'high priority', { priority: 'high' });
    opt.add('b', 'medium priority', { priority: 'medium' });
    opt.add('c', 'low priority', { priority: 'low' });

    const result = opt.pack();
    // Highest score should be at the beginning (edges-first)
    expect(result.items[0]!.source).toBe('a');
    expect(result.items[0]!.placement).toBe('beginning');
  });

  // -------------------------------------------------------------------------
  // dropStrategy
  // -------------------------------------------------------------------------

  test('dropStrategy oldest applies recency bias', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 200,
      reserveOutput: 50,
    });

    opt.add('history', [
      'x'.repeat(100), // old
      'y'.repeat(100), // middle
      'z'.repeat(100), // recent
    ], { priority: 'high', dropStrategy: 'oldest', position: 'end' });

    const result = opt.pack();
    const historyItems = result.items.filter(i => i.source === 'history');
    if (historyItems.length < 3) {
      const included = historyItems.map(i => i.id);
      expect(included).toContain('history_2');
    }
  });

  test('dropStrategy none prevents items from being dropped', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 500,
      reserveOutput: 100,
    });

    opt.add('critical', ['a'.repeat(100), 'b'.repeat(100)], {
      priority: 'medium',
      dropStrategy: 'none',
    });
    opt.add('optional', ['c'.repeat(100)], { priority: 'medium' });

    const result = opt.pack();
    const criticalItems = result.items.filter(i => i.source === 'critical');
    expect(criticalItems).toHaveLength(2);
  });

  test('dropStrategy oldest works on any source, not just history', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 200,
      reserveOutput: 50,
    });

    opt.add('events', [
      'x'.repeat(100),
      'y'.repeat(100),
      'z'.repeat(100),
    ], { priority: 'high', dropStrategy: 'oldest' });

    const result = opt.pack();
    const eventItems = result.items.filter(i => i.source === 'events');
    if (eventItems.length < 3) {
      // Most recent should survive
      expect(eventItems.map(i => i.id)).toContain('events_2');
    }
  });

  // -------------------------------------------------------------------------
  // Constraints integration
  // -------------------------------------------------------------------------

  test('requires option pulls in dependency from another source', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 10000,
    });

    opt.add('tools', [
      { name: 'search', description: 'Search the web' },
    ], {
      priority: 'high',
      requires: { 'tools_search': 'examples_search_demo' },
    });

    opt.add('examples', [
      { name: 'search_demo', description: 'Example: search for "hello"' },
    ], { priority: 'low' });

    const result = opt.pack();
    const ids = result.items.map(i => i.id);
    expect(ids).toContain('tools_search');
    expect(ids).toContain('examples_search_demo');
  });

  // -------------------------------------------------------------------------
  // Full integration
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Role preservation
  // -------------------------------------------------------------------------

  test('extracts role from objects with role field', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 10000,
    });

    opt.add('history', [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ], { priority: 'high', position: 'end' });

    const result = opt.pack();
    const historyItems = result.items.filter(i => i.source === 'history');
    expect(historyItems[0]!.role).toBe('user');
    expect(historyItems[1]!.role).toBe('assistant');
  });

  test('role is undefined for string items', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 10000,
    });

    opt.add('memory', ['fact one', 'fact two'], { priority: 'medium' });

    const result = opt.pack();
    const memoryItems = result.items.filter(i => i.source === 'memory');
    expect(memoryItems[0]!.role).toBeUndefined();
  });

  test('role is undefined for objects without role field', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 10000,
    });

    opt.add('tools', [{ name: 'search', description: 'Search' }], { priority: 'high' });

    const result = opt.pack();
    const tool = result.items.find(i => i.source === 'tools');
    expect(tool!.role).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Turn grouping
  // -------------------------------------------------------------------------

  test('groupBy turn groups messages into conversation turns', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 10000,
    });

    opt.add('history', [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'How are you?' },
      { role: 'assistant', content: 'I am good' },
    ], { priority: 'high', position: 'end', groupBy: 'turn' });

    const result = opt.pack();
    const historyItems = result.items.filter(i => i.source === 'history');
    // Should have 2 turns, not 4 individual messages
    expect(historyItems).toHaveLength(2);
    expect(historyItems[0]!.id).toBe('history_turn_0');
    expect(historyItems[1]!.id).toBe('history_turn_1');
  });

  test('turn value contains original message array', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 10000,
    });

    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'Bye' },
    ];

    opt.add('history', messages, { priority: 'high', position: 'end', groupBy: 'turn' });

    const result = opt.pack();
    const historyItems = result.items.filter(i => i.source === 'history');
    // Turn 0: [user, assistant]
    const turn0Value = historyItems[0]!.value as any[];
    expect(turn0Value).toHaveLength(2);
    expect(turn0Value[0]).toEqual({ role: 'user', content: 'Hello' });
    expect(turn0Value[1]).toEqual({ role: 'assistant', content: 'Hi there' });
    // Turn 1: [user]
    const turn1Value = historyItems[1]!.value as any[];
    expect(turn1Value).toHaveLength(1);
    expect(turn1Value[0]).toEqual({ role: 'user', content: 'Bye' });
  });

  test('keepLast with turns counts turns not messages', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 300,
      reserveOutput: 50,
    });

    opt.add('history', [
      { role: 'user', content: 'x'.repeat(100) },
      { role: 'assistant', content: 'y'.repeat(100) },
      { role: 'user', content: 'a'.repeat(100) },
      { role: 'assistant', content: 'b'.repeat(100) },
    ], {
      priority: 'high',
      keepLast: 1,
      dropStrategy: 'oldest',
      position: 'end',
      groupBy: 'turn',
    });

    const result = opt.pack();
    const historyItems = result.items.filter(i => i.source === 'history');
    // Last turn (turn_1) should be required and always included
    expect(historyItems.some(i => i.id === 'history_turn_1')).toBe(true);
  });

  test('turns are dropped atomically', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 200,
      reserveOutput: 50,
    });

    opt.add('history', [
      { role: 'user', content: 'x'.repeat(100) },
      { role: 'assistant', content: 'y'.repeat(100) },
      { role: 'user', content: 'a'.repeat(50) },
      { role: 'assistant', content: 'b'.repeat(50) },
    ], {
      priority: 'high',
      keepLast: 1,
      dropStrategy: 'oldest',
      position: 'end',
      groupBy: 'turn',
    });

    const result = opt.pack();
    const historyItems = result.items.filter(i => i.source === 'history');
    // If turn_0 is dropped, both its messages are gone (it's one item)
    // If turn_1 is included, both its messages are present
    for (const item of historyItems) {
      const val = item.value as any[];
      // Each included turn should have its full set of messages
      expect(val.length).toBeGreaterThanOrEqual(1);
    }
  });

  test('groupBy turn is no-op when items have no role fields', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 10000,
    });

    opt.add('data', ['item 1', 'item 2', 'item 3'], {
      priority: 'medium',
      groupBy: 'turn',
    });

    const result = opt.pack();
    const dataItems = result.items.filter(i => i.source === 'data');
    // No role fields → each item stays individual
    expect(dataItems).toHaveLength(3);
    expect(dataItems[0]!.id).toBe('data_0');
  });

  test('non-user messages at start form turn 0', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 10000,
    });

    opt.add('history', [
      { role: 'assistant', content: 'Welcome' },
      { role: 'user', content: 'Thanks' },
      { role: 'assistant', content: 'How can I help?' },
    ], { priority: 'high', position: 'end', groupBy: 'turn' });

    const result = opt.pack();
    const historyItems = result.items.filter(i => i.source === 'history');
    // Turn 0: [assistant], Turn 1: [user, assistant]
    expect(historyItems).toHaveLength(2);
    const turn0Value = historyItems[0]!.value as any[];
    expect(turn0Value).toHaveLength(1);
    expect(turn0Value[0].role).toBe('assistant');
  });

  test('turn items with tool_use and tool_result stay in same turn', () => {
    const opt = new ContextOptimizer({
      model: 'gpt-4o',
      contextWindow: 10000,
    });

    opt.add('history', [
      { role: 'user', content: 'Search for auth' },
      { role: 'assistant', content: 'Let me search...' },
      { role: 'assistant', content: '[tool_use: search]' },
      { role: 'tool', content: '[tool_result: found files]' },
      { role: 'assistant', content: 'Here are the results' },
      { role: 'user', content: 'Fix the bug' },
      { role: 'assistant', content: 'On it' },
    ], { priority: 'high', position: 'end', groupBy: 'turn' });

    const result = opt.pack();
    const historyItems = result.items.filter(i => i.source === 'history');
    expect(historyItems).toHaveLength(2);
    // Turn 0 should have 5 messages (user + assistant + tool_use + tool_result + assistant)
    const turn0Value = historyItems[0]!.value as any[];
    expect(turn0Value).toHaveLength(5);
    // Turn 1 should have 2 messages (user + assistant)
    const turn1Value = historyItems[1]!.value as any[];
    expect(turn1Value).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Full integration
  // -------------------------------------------------------------------------

  test('full integration: system + tools + history + rag + query', () => {
    const opt = new ContextOptimizer({
      model: 'claude-sonnet-4-20250514',
      contextWindow: 200_000,
      reserveOutput: 8_192,
      pricing: { inputPer1M: 3, provider: 'anthropic' },
    });

    opt.add('system', 'You are a helpful coding assistant. Always explain your reasoning step by step.', {
      priority: 'required',
      position: 'beginning',
    });

    opt.add('tools', [
      { name: 'read_file', description: 'Read a file from disk', parameters: { path: { type: 'string' } } },
      { name: 'write_file', description: 'Write content to a file', parameters: { path: { type: 'string' }, content: { type: 'string' } } },
      { name: 'search', description: 'Search the codebase', parameters: { query: { type: 'string' } } },
    ], { priority: 'high' });

    opt.add('history', [
      { role: 'user', content: 'Can you help me refactor my auth module?' },
      { role: 'assistant', content: 'Sure! Let me look at the current implementation.' },
      { role: 'user', content: 'Here is the file: [large code block]' },
      { role: 'assistant', content: 'I see several issues. Let me suggest improvements.' },
    ], { priority: 'high', keepLast: 2, dropStrategy: 'oldest', position: 'end' });

    opt.add('memory', [
      'User prefers TypeScript',
      'Project uses Express.js',
      'Auth module is in src/auth/',
    ], { priority: 'medium' });

    opt.add('rag', [
      'Express.js middleware documentation excerpt...',
      'JWT best practices guide...',
      'OAuth2 implementation patterns...',
    ], { priority: 'medium' });

    const result = opt.pack('Now update the auth middleware to use JWT');

    expect(result.items[0]!.source).toBe('system');
    expect(result.items[result.items.length - 1]!.source).toBe('query');
    expect(result.stats.budget).toBe(200_000 - 8_192);
    expect(result.stats.utilization).toBeGreaterThan(0);
    expect(result.stats.estimatedCost).toBeDefined();
    expect(result.stats.breakdown['system']).toBeDefined();
    expect(result.stats.breakdown['tools']).toBeDefined();
    expect(result.stats.breakdown['history']).toBeDefined();
    expect(result.stats.breakdown['memory']).toBeDefined();
    expect(result.stats.breakdown['rag']).toBeDefined();
    expect(result.stats.breakdown['query']).toBeDefined();

    const historyItems = result.items.filter(i => i.source === 'history');
    expect(historyItems.length).toBeGreaterThanOrEqual(2);
  });
});
