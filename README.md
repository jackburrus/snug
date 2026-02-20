# snug

Intelligent context window packing for LLMs.

```
npm install snug-ai
```

snug decides what goes into your LLM's context window, where it's placed, and what gets cut — so you don't have to.

```typescript
import { ContextOptimizer } from 'snug-ai';

const optimizer = new ContextOptimizer({
  model: 'claude-sonnet-4-20250514',
  contextWindow: 200_000,
  reserveOutput: 8_192,
});

optimizer.add('system', systemPrompt, { priority: 'required', position: 'beginning' });
optimizer.add('tools', toolDefinitions, { priority: 'high' });
optimizer.add('history', messages, { priority: 'high', keepLast: 2, dropStrategy: 'oldest', position: 'end', groupBy: 'turn' });
optimizer.add('memory', memoryResults, { priority: 'medium' });
optimizer.add('rag', ragChunks, { priority: 'medium' });

const result = optimizer.pack('Update the auth middleware to use JWT');

result.items     // Ordered context, ready to send
result.stats     // Token counts, cost, per-source breakdown
result.warnings  // Actionable alerts
result.dropped   // What was excluded and why
```

Zero dependencies. Works with any provider.

---

## The problem

Here's what happens when you naively pack an LLM context — system prompt, 12 tools, 30-message history, and 15 RAG chunks into a 1,600 token budget:

```
                              NAIVE              SNUG
─────────────────────────── ──────────────────── ──────────────────
Recent history preserved?    No (truncated)       Yes (atomic turns)
High-relevance RAG included  0/3                  3/3
Items in attention dead zone 9                    0 high-value
Tool count                   12                   12
Placement strategy           Sequential           Edges-first (U-curve)
Drop strategy                Cut at end           Score-based
```

The naive approach fills the window top-to-bottom and cuts when full. The most recent messages — the ones the model needs most — are the first to go. High-relevance RAG chunks never make it in. History messages get buried in the middle of the context where the model barely attends to them.

This isn't a theoretical problem. Research quantifies it:

- **Lost in the Middle** (Liu et al., TACL 2024) — LLMs follow a U-shaped attention curve. The middle of context is effectively ignored. Performance degrades **30%+** based purely on position.
- **Context Distraction** (Gemini 2.5 tech report) — Beyond ~100K tokens, models over-focus on context and neglect their training knowledge.
- **Tool Overload** (Berkeley Function-Calling Leaderboard) — Every model performs worse with more tools. Llama 3.1 8b failed with 46 tools, succeeded with 19.
- **Context Clash** (Microsoft/Salesforce) — Multi-turn context caused a **39% average performance drop**. o3 went from 98.1 to 64.1.

snug fixes this by scoring every item, packing by priority, and placing high-value content at the edges of the context window where attention is strongest.

> Run `bun examples/10-before-after.ts` to see the full comparison, or `bun examples/11-visualize-context.ts` to see the U-shaped attention map for your context.

---

## How it works

Every `pack()` call runs five stages:

**Measure** — Count tokens per item. Built-in heuristic or bring your own tokenizer.

**Score** — Rank items by priority tier, recency, and optional custom scoring.

**Pack** — Greedy knapsack. Required items always go in. Remaining budget fills by score. Everything that doesn't fit is tracked with reasons.

**Place** — Rearrange based on the U-shaped attention curve. High-value items land at the edges where attention is strongest. Low-value items go in the middle:

```
Attention
100%|█                                  █      ← system prompt, recent history, query
    |████                            ████
    |████████                    ████████
    |██████████████      ████████████████
 30%|████████████████████████████████████      ← low-priority items here
    +------------------------------------
    START              MID              END
```

**Report** — Full breakdown of what happened:

```typescript
result.stats.totalTokens    // 47,832
result.stats.budget          // 191,808
result.stats.utilization     // 0.249
result.stats.estimatedCost   // { input: '$0.1435', provider: 'anthropic' }
result.stats.breakdown       // per-source: tokens, items included, items dropped
```

---

## Features

- **Priority tiers** — `required` > `high` > `medium` > `low`. Required items always make it in. Everything else competes for remaining budget.
- **Recency bias** — `dropStrategy: 'oldest'` decays old messages to 10% of their score. Recent conversation survives. Old context drops first.
- **Turn grouping** — `groupBy: 'turn'` packs conversation history as atomic turns. No orphaned tool calls. No split assistant responses. `keepLast` counts turns, not messages.
- **Role preservation** — `role` is extracted from input objects and carried through to output. Map directly to API messages without guessing.
- **Lost-in-the-middle placement** — Pin items to `beginning` or `end`. Floating items are arranged edges-first by score.
- **Dependency constraints** — `requires: { 'tools_search': 'examples_search_demo' }` — if the example can't fit, the tool is removed instead of shipping without context.
- **Custom scoring** — Plug in embedding similarity, BM25, or any scoring function.
- **Warnings** — Detects budget overflows, lost-in-the-middle placement issues, tool overload (>10 tools), high drop rates, and low utilization.
- **Cost estimation** — Per-call cost estimates when you provide pricing.
- **Custom tokenizer** — Built-in heuristic is conservative (~10-15% over). Swap in tiktoken or any `{ count(text): number }` for exact counts.

---

## Packing conversation history

The thing most context managers get wrong: conversations aren't flat arrays. A user message, the assistant's response, its tool calls, and the tool results are one logical unit. Dropping the tool result but keeping the tool call breaks the conversation.

```typescript
optimizer.add('history', [
  { role: 'user', content: 'Search for the auth bug' },
  { role: 'assistant', content: 'Let me search...' },
  { role: 'assistant', content: '[tool_use: search]' },
  { role: 'tool', content: '[result: found in session.ts]' },
  { role: 'assistant', content: 'Found it in session.ts' },
  { role: 'user', content: 'Fix it' },
  { role: 'assistant', content: 'Done. Here is the patch...' },
], {
  priority: 'high',
  keepLast: 1,           // last turn is always included
  dropStrategy: 'oldest',
  position: 'end',
  groupBy: 'turn',       // pack as atomic turns
});
```

This produces two turns. Turn 0 has 5 messages (user through final assistant). Turn 1 has 2 messages. They're packed and dropped as units. `keepLast: 1` means the last *turn* is required, not the last message.

To reconstruct API messages from turns:

```typescript
for (const item of result.items.filter(i => i.source === 'history')) {
  for (const msg of item.value as any[]) {
    apiMessages.push({ role: msg.role, content: msg.content });
  }
}
```

---

## Sending to your LLM

### Anthropic

```typescript
const result = optimizer.pack('Refactor the auth module');

const response = await anthropic.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 8192,
  system: result.items.filter(i => i.source === 'system').map(i => i.content).join('\n'),
  messages: result.items
    .filter(i => i.source !== 'system')
    .map(i => ({
      role: i.role === 'assistant' ? 'assistant' as const : 'user' as const,
      content: i.content,
    })),
});
```

### OpenAI

```typescript
const result = optimizer.pack('Refactor the auth module');

const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: result.items.map(i => ({
    role: i.role ?? (i.source === 'system' ? 'system' as const : 'user' as const),
    content: i.content,
  })),
});
```

snug is provider-agnostic. Use `source`, `role`, `placement`, and `value` on each item to build whatever format your provider expects.

---

## API reference

### `new ContextOptimizer(config)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `model` | `string` | *required* | Model identifier (used for cost estimation) |
| `contextWindow` | `number` | *required* | Total context window size in tokens |
| `reserveOutput` | `number` | `4096` | Tokens reserved for model output |
| `tokenizer` | `{ count(text: string): number }` | built-in | Custom tokenizer |
| `pricing` | `{ inputPer1M: number }` | — | Enable cost estimation |

### `optimizer.add(source, content, options)`

Register a context source. Arrays become independently-scored items. Objects are JSON-stringified. Re-adding the same source name replaces it.

| Option | Type | Description |
|--------|------|-------------|
| `priority` | `'required' \| 'high' \| 'medium' \| 'low'` | Priority tier. Required items are always included. |
| `position` | `'beginning' \| 'end'` | Pin to start or end. Unpinned items float. |
| `keepLast` | `number` | Promote last N items (or turns) to required. |
| `dropStrategy` | `'relevance' \| 'oldest' \| 'none'` | How to handle items that don't fit. |
| `groupBy` | `'turn'` | Group into conversation turns. Packed/dropped atomically. |
| `scorer` | `(item, query) => number` | Custom scoring function. |
| `requires` | `Record<string, string>` | Dependency constraints between items. |

### `optimizer.pack(query?)`

Returns `{ items, stats, warnings, dropped }`. Query is included as a required item at the end.

### `optimizer.remove(source)` / `optimizer.clear()`

Remove one source or all sources.

---

## License

MIT
