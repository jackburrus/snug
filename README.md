# snug

Fit the right context into your LLM's window.

```
npm install snug-ai
```

snug takes everything you want in your LLM's context — system prompts, tools, conversation history, memory, RAG chunks — and packs it into an optimally arranged context window with full visibility into what was included, what was dropped, and why.

## Why

Every token in your context window costs attention. Research shows:

- **Lost in the Middle** (Liu et al., TACL 2024): LLM performance follows a U-shaped curve. Information at the beginning and end of context is used well; the middle is effectively ignored. Performance degrades 30%+ based purely on *position*.
- **Context Distraction** (Gemini 2.5 tech report): Beyond ~100K tokens, models over-focus on context and neglect training knowledge.
- **Tool Overload** (Berkeley Function-Calling Leaderboard): Every model performs worse with more tools. A quantized Llama 3.1 8b failed with 46 tools but succeeded with 19.
- **Context Clash** (Microsoft/Salesforce): Information gathered over multiple turns caused a 39% average performance drop; o3 dropped from 98.1 to 64.1.

Bigger context windows don't solve this. The problem is architectural. snug helps you pack smarter.

## Quick Start

```typescript
import { ContextOptimizer } from 'snug-ai';

const optimizer = new ContextOptimizer({
  model: 'claude-sonnet-4-20250514',
  contextWindow: 200_000,
  reserveOutput: 8_192,
});

// Register your context sources
optimizer.add('system', 'You are a helpful coding assistant.', {
  priority: 'required',
  position: 'beginning',
});

optimizer.add('tools', [
  { name: 'read_file', description: 'Read a file', parameters: { path: { type: 'string' } } },
  { name: 'search', description: 'Search code', parameters: { query: { type: 'string' } } },
], { priority: 'high' });

optimizer.add('history', conversationMessages, {
  priority: 'high',
  keepLast: 3,
  dropStrategy: 'oldest',
  position: 'end',
});

optimizer.add('memory', memoryResults, { priority: 'medium' });
optimizer.add('rag', ragChunks, { priority: 'medium' });

// Pack for a specific query
const result = optimizer.pack('Update the auth middleware to use JWT');

result.items;    // Ordered context blocks, ready to use
result.stats;    // Token counts, cost estimate, per-source breakdown
result.warnings; // Actionable alerts (lost-in-middle, tool overload, etc.)
result.dropped;  // What was excluded and why
```

## What It Does

snug runs five stages on every `pack()` call:

**1. Measure** — Count tokens per item using a built-in heuristic (~4 chars/token for English, ~3 chars/token for code/JSON). Bring your own tokenizer for exact counts.

**2. Score** — Assign relevance scores. Required items get `Infinity`. High/medium/low tiers get base scores. History items are decayed by recency (oldest messages score lowest). You can pass a custom scorer for domain-specific relevance.

**3. Pack** — Greedy knapsack optimization. Required items go in first. Remaining budget is filled by score, highest first. Items that don't fit are recorded with reasons.

**4. Place** — Position-aware arrangement based on "Lost in the Middle" research. System prompt at the beginning (primacy). Recent history and query at the end (recency). High-scoring items at the edges. Low-scoring items in the middle where attention is weakest.

**5. Report** — Full visibility into the packing decision:

```typescript
result.stats = {
  totalTokens: 47832,
  budget: 191808,
  utilization: 0.249,
  estimatedCost: { input: '$0.1435', provider: 'anthropic' }, // requires pricing config
  breakdown: {
    system: { tokens: 12, items: 1 },
    tools: { tokens: 156, items: 2, dropped: 1, reason: 'budget exhausted' },
    history: { tokens: 8420, items: 6, dropped: 14 },
    memory: { tokens: 2100, items: 3 },
    rag: { tokens: 36800, items: 8, dropped: 4, reason: 'budget exhausted' },
    query: { tokens: 344, items: 1 },
  },
}
```

## API

### `new ContextOptimizer(config)`

```typescript
const optimizer = new ContextOptimizer({
  model: 'claude-sonnet-4-20250514', // Used for cost estimation
  contextWindow: 200_000,             // Total tokens available
  reserveOutput: 8_192,               // Reserved for model output (default: 4096)
  tokenizer: myTokenizer,             // Optional: { count(text: string): number }
  pricing: { inputPer1M: 3 },         // Optional: override built-in cost table
});
```

### `optimizer.add(source, content, options)`

Register a context source. Arrays are split into independently-scored items. Objects are JSON-stringified. Calling `add()` with the same source name replaces the previous registration.

```typescript
optimizer.add('system', systemPrompt, { priority: 'required', position: 'beginning' });
optimizer.add('tools', toolDefinitions, { priority: 'high' });
optimizer.add('history', messages, { priority: 'high', keepLast: 3, dropStrategy: 'oldest', position: 'end' });
optimizer.add('memory', memoryResults, { priority: 'medium' });
optimizer.add('rag', ragChunks, { priority: 'medium' });
```

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| `priority` | `'required' \| 'high' \| 'medium' \| 'low'` | Priority tier. Required items are always included. |
| `position` | `'beginning' \| 'end'` | Pin items to the start or end of the context. Unpinned items float (edges-first by score). |
| `keepLast` | `number` | Promote the last N items to required (useful for recent history). |
| `dropStrategy` | `'relevance' \| 'oldest' \| 'none'` | `'relevance'`: drop lowest-scored first. `'oldest'`: drop oldest first (recency bias). `'none'`: never drop. |
| `groupBy` | `'turn'` | Group messages into conversation turns. A new turn starts at each `role: 'user'` message. Turns are packed/dropped atomically. `keepLast` counts turns. |
| `scorer` | `(item, query) => number` | Custom scoring function. Overrides priority-based scoring. |
| `requires` | `Record<string, string>` | Dependency constraints: if item A is included, item B must be too. |

### `optimizer.pack(query?)`

Pack all registered sources into an optimized context. The optional query string is included as a required item at the end and used for custom scorers.

Returns `PackResult`:

```typescript
interface PackResult {
  items: PackedItem[];     // Ordered items that fit
  stats: Stats;            // Token counts, cost, breakdown
  warnings: Warning[];     // Actionable alerts
  dropped: DroppedItem[];  // What was excluded
}
```

### `optimizer.remove(source)` / `optimizer.clear()`

Remove a single source or clear all sources.

## Features

### Priority Tiers

Items are scored by tier: `required` (always included) > `high` (100) > `medium` (50) > `low` (10). Within a tier, items compete on score for remaining budget.

### Recency Bias

Sources with `dropStrategy: 'oldest'` automatically apply recency weighting. Oldest items are decayed to 10% of their base score; newest items retain full score. Combined with `keepLast`, this ensures recent conversation is preserved while old messages are dropped first when budget is tight.

### Lost-in-the-Middle Placement

After packing, items are rearranged to exploit the U-shaped attention curve:
- Items with `position: 'beginning'` are pinned at the **start** (primacy)
- Items with `position: 'end'` are pinned at the **end** (recency)
- Floating items (no position) are arranged edges-first: highest-scored at the beginning and end, lowest-scored in the **middle** where LLM attention is weakest

### Conversation History

Use `groupBy: 'turn'` to pack conversation history as atomic turns instead of individual messages. A turn starts at each `role: 'user'` message and includes everything until the next user message (assistant replies, tool calls, tool results).

```typescript
optimizer.add('history', [
  { role: 'user', content: 'Help with auth' },
  { role: 'assistant', content: 'Looking at the code...' },
  { role: 'user', content: 'Fix the session bug' },
  { role: 'assistant', content: 'Found the issue...' },
], {
  priority: 'high',
  keepLast: 1,          // last 1 turn is required (not message)
  dropStrategy: 'oldest',
  position: 'end',
  groupBy: 'turn',      // group into conversation turns
});
```

With `groupBy: 'turn'`:
- Each turn is packed/dropped as a single unit — no orphaned tool calls or split conversations
- `keepLast` counts turns, not messages
- Recency bias applies at the turn level
- Each turn's `value` contains the original message array, making it easy to reconstruct API messages:

```typescript
for (const item of result.items) {
  if (item.source === 'history') {
    for (const msg of item.value as any[]) {
      apiMessages.push({ role: msg.role, content: msg.content });
    }
  }
}
```

Items without `role` fields are left ungrouped — `groupBy: 'turn'` is a no-op for plain strings or objects without roles.

### Role Preservation

snug extracts the `role` field from input objects and carries it through to `PackedItem.role`. This means output items are directly usable for LLM API message construction without needing to infer roles from source names.

### Dependency Constraints

Ensure related items are co-included:

```typescript
optimizer.add('tools', tools, {
  priority: 'high',
  requires: { 'tools_search': 'examples_search_demo' },
});

optimizer.add('examples', examples, { priority: 'low' });
```

If `tools_search` is included but `examples_search_demo` can't fit, the tool is removed instead of shipping without its example.

### Custom Scoring

Override the default priority-based scoring with domain-specific logic:

```typescript
optimizer.add('rag', ragChunks, {
  priority: 'medium',
  scorer: (item, query) => cosineSimilarity(embed(item.content), embed(query)),
});
```

### Warnings

snug detects common context engineering mistakes:

| Warning | Trigger |
|---------|---------|
| `budget-exceeded` | Required items alone exceed the token budget |
| `lost-in-middle` | High-relevance items placed in the middle 40% of context |
| `tool-overload` | More than 10 tool definitions (research shows degradation) |
| `high-drop-rate` | More than 50% of items were dropped |
| `low-utilization` | Less than 10% of budget used with nothing dropped |

### Cost Estimation

Pass your model's pricing to get per-call cost estimates in `result.stats.estimatedCost`:

```typescript
const optimizer = new ContextOptimizer({
  model: 'claude-sonnet-4-20250514',
  contextWindow: 200_000,
  pricing: { inputPer1M: 3, provider: 'anthropic' },
});
```

Without `pricing`, `estimatedCost` is `undefined`.

### Custom Tokenizer

The built-in heuristic is fast but approximate (~10-15% over-estimation, which is conservative/safe — it will never exceed your budget). It smoothly interpolates between 4 chars/token for prose and 3 chars/token for code/JSON based on structural character density. For exact counts, bring your own tokenizer:

```typescript
import { encoding_for_model } from 'tiktoken';

const enc = encoding_for_model('gpt-4o');
const optimizer = new ContextOptimizer({
  model: 'gpt-4o',
  contextWindow: 128_000,
  tokenizer: { count: (text) => enc.encode(text).length },
});
```

## Usage with Providers

snug gives you packed, ordered content — here's how to feed it to your LLM:

### Anthropic (Claude)

```typescript
import Anthropic from '@anthropic-ai/sdk';

const result = optimizer.pack('Refactor the auth module');

const systemItems = result.items.filter(i => i.source === 'system');
const messageItems = result.items.filter(i => i.source !== 'system');

const response = await new Anthropic().messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 8192,
  system: systemItems.map(i => i.content).join('\n'),
  messages: messageItems.map(i => ({
    role: i.role === 'assistant' ? 'assistant' as const : 'user' as const,
    content: i.content,
  })),
});
```

### OpenAI

```typescript
import OpenAI from 'openai';

const result = optimizer.pack('Refactor the auth module');

const messages = result.items.map(i => ({
  role: i.role ?? (i.source === 'system' ? 'system' as const : 'user' as const),
  content: i.content,
}));

const response = await new OpenAI().chat.completions.create({
  model: 'gpt-4o',
  messages,
});
```

The exact mapping depends on your application — snug is intentionally provider-agnostic. Use the `source`, `role`, `placement`, and `value` fields on each `PackedItem` to build whatever message format your provider expects.

## Item IDs

Objects with `name` or `id` fields get human-readable item IDs:

```typescript
optimizer.add('tools', [{ name: 'search', ... }], { priority: 'high' });
// Item ID: "tools_search"
```

This makes the `dropped` array and stats breakdown easy to understand at a glance.

## Zero Dependencies

snug has zero runtime dependencies. The built-in token estimator, priority scorer, greedy packer, and placement optimizer are all self-contained. Optional integrations (custom tokenizers, embedding-based scoring) are bring-your-own.

## License

MIT
