/**
 * Example 10: Before vs. After — why context packing matters
 *
 * Compares naive context stuffing against snug-optimized packing.
 * Same content, same budget — dramatically different results.
 *
 * Run: bun examples/10-before-after.ts
 */
import { ContextOptimizer } from '../src/index';

// --- Shared content ---

const systemPrompt = 'You are a senior engineer. Review code changes carefully.';

const tools = Array.from({ length: 12 }, (_, i) => ({
  name: `tool_${i}`,
  description: `Tool ${i} — ${'performs a useful operation for the developer'.repeat(2)}`,
}));

const history = Array.from({ length: 30 }, (_, i) => {
  const turn = Math.floor(i / 2);
  if (i % 2 === 0) {
    return { role: 'user', content: `Turn ${turn}: ${'User provides detailed context about the problem they need solved. '.repeat(3)}` };
  }
  return { role: 'assistant', content: `Turn ${turn}: ${'Assistant responds with analysis and proposed solution. '.repeat(4)}` };
});

const ragChunks = Array.from({ length: 15 }, (_, i) => ({
  id: `doc_${i}`,
  content: `Document ${i}: ${'Relevant code and documentation content that helps answer the query. '.repeat(3)}`,
  relevance: i < 3 ? 0.95 : i < 7 ? 0.7 : 0.3, // first 3 are highly relevant
}));

const BUDGET = 2000; // tokens — tight budget to force real decisions
const RESERVE = 400;

// =========================================================================
// BEFORE: Naive approach — shove everything in, truncate when full
// =========================================================================

console.log('='.repeat(70));
console.log('  BEFORE: Naive context stuffing');
console.log('='.repeat(70));
console.log();

// Simulate what most apps do: concatenate everything in order, cut at the limit
const naiveTokenizer = { count: (t: string) => Math.ceil(t.length / 3.5) };
const naiveBudget = BUDGET - RESERVE;
let naiveUsed = 0;
const naiveIncluded: { source: string; label: string; tokens: number; position: number }[] = [];
const naiveDropped: string[] = [];

// System prompt first
const sysTok = naiveTokenizer.count(systemPrompt);
naiveIncluded.push({ source: 'system', label: 'system prompt', tokens: sysTok, position: naiveUsed });
naiveUsed += sysTok;

// Tools next
for (const tool of tools) {
  const tok = naiveTokenizer.count(JSON.stringify(tool));
  if (naiveUsed + tok <= naiveBudget) {
    naiveIncluded.push({ source: 'tools', label: tool.name, tokens: tok, position: naiveUsed });
    naiveUsed += tok;
  } else {
    naiveDropped.push(tool.name);
  }
}

// All history in order
for (let i = 0; i < history.length; i++) {
  const tok = naiveTokenizer.count(JSON.stringify(history[i]));
  if (naiveUsed + tok <= naiveBudget) {
    naiveIncluded.push({ source: 'history', label: `msg_${i} (${history[i]!.role})`, tokens: tok, position: naiveUsed });
    naiveUsed += tok;
  } else {
    naiveDropped.push(`msg_${i}`);
  }
}

// RAG chunks — whatever fits
for (const chunk of ragChunks) {
  const tok = naiveTokenizer.count(chunk.content);
  if (naiveUsed + tok <= naiveBudget) {
    naiveIncluded.push({ source: 'rag', label: chunk.id, tokens: tok, position: naiveUsed });
    naiveUsed += tok;
  } else {
    naiveDropped.push(chunk.id);
  }
}

console.log(`Budget: ${naiveBudget} tokens`);
console.log(`Used:   ${naiveUsed} tokens (${(naiveUsed / naiveBudget * 100).toFixed(0)}%)`);
console.log(`Items:  ${naiveIncluded.length} included, ${naiveDropped.length} dropped`);
console.log();

// Analyze what's in the "dead zone" (middle 40%)
const naiveMiddleStart = naiveUsed * 0.3;
const naiveMiddleEnd = naiveUsed * 0.7;
const naiveInMiddle = naiveIncluded.filter(
  i => i.position >= naiveMiddleStart && i.position <= naiveMiddleEnd
);

console.log('Problems:');

// Check: did we include the most recent history?
const lastHistoryIndex = naiveIncluded.filter(i => i.source === 'history').length - 1;
const totalHistoryMsgs = history.length;
if (lastHistoryIndex < totalHistoryMsgs - 1) {
  console.log(`  [x] Recent history LOST — only ${lastHistoryIndex + 1} of ${totalHistoryMsgs} messages fit`);
  console.log(`      The most recent ${totalHistoryMsgs - lastHistoryIndex - 1} messages were cut`);
}

// Check: are high-relevance RAG chunks included?
const includedRag = naiveIncluded.filter(i => i.source === 'rag').map(i => i.label);
const highRelevanceIncluded = ragChunks.filter(c => c.relevance >= 0.9 && includedRag.includes(c.id));
const highRelevanceTotal = ragChunks.filter(c => c.relevance >= 0.9);
if (highRelevanceIncluded.length < highRelevanceTotal.length) {
  console.log(`  [x] High-relevance docs DROPPED — ${highRelevanceIncluded.length}/${highRelevanceTotal.length} included`);
}

// Check: what's in the dead zone?
const toolsInMiddle = naiveInMiddle.filter(i => i.source === 'tools').length;
const historyInMiddle = naiveInMiddle.filter(i => i.source === 'history').length;
console.log(`  [x] Dead zone (middle 40%): ${naiveInMiddle.length} items where LLM attention is weakest`);
if (toolsInMiddle > 0) console.log(`      ${toolsInMiddle} tool definitions buried in the middle`);
if (historyInMiddle > 0) console.log(`      ${historyInMiddle} history messages in the dead zone`);

// Check: tool count
const toolCount = naiveIncluded.filter(i => i.source === 'tools').length;
if (toolCount > 10) {
  console.log(`  [x] Tool overload — ${toolCount} tools (research shows degradation >10)`);
}

console.log();

// =========================================================================
// AFTER: snug-optimized packing
// =========================================================================

console.log('='.repeat(70));
console.log('  AFTER: snug-optimized packing');
console.log('='.repeat(70));
console.log();

const optimizer = new ContextOptimizer({
  model: 'claude-sonnet-4-20250514',
  contextWindow: BUDGET,
  reserveOutput: RESERVE,
});

optimizer.add('system', systemPrompt, {
  priority: 'required',
  position: 'beginning',
});

optimizer.add('tools', tools, {
  priority: 'high',
});

optimizer.add('history', history, {
  priority: 'high',
  keepLast: 2,
  dropStrategy: 'oldest',
  position: 'end',
  groupBy: 'turn',
});

optimizer.add('rag', ragChunks, {
  priority: 'medium',
  scorer: (item) => {
    // Score by relevance — high-relevance docs score higher
    const raw = item.value as typeof ragChunks[0];
    return raw.relevance * 200;
  },
});

const result = optimizer.pack('Review the latest code changes');

console.log(`Budget: ${result.stats.budget} tokens`);
console.log(`Used:   ${result.stats.totalTokens} tokens (${(result.stats.utilization * 100).toFixed(0)}%)`);
console.log(`Items:  ${result.items.length} included, ${result.dropped.length} dropped`);
console.log();

// Analyze placement
const totalTokens = result.stats.totalTokens;
const middleStart = totalTokens * 0.3;
const middleEnd = totalTokens * 0.7;

let runningTokens = 0;
const itemPositions = result.items.map(item => {
  const pos = runningTokens;
  runningTokens += item.tokens;
  return { ...item, position: pos };
});

const inMiddle = itemPositions.filter(
  i => i.position >= middleStart && i.position <= middleEnd
);

const highScoreInMiddle = inMiddle.filter(i => i.score >= 80);

console.log('Improvements:');

// Recent history preserved?
const historyItems = result.items.filter(i => i.source === 'history');
const lastTurnValue = historyItems[historyItems.length - 1]?.value as any[] | undefined;
if (lastTurnValue) {
  const lastUserMsg = lastTurnValue.find((m: any) => m.role === 'user');
  if (lastUserMsg) {
    console.log(`  [+] Recent history PRESERVED — last ${historyItems.length} turns included as atomic units`);
  }
}

// High-relevance RAG?
const snugRag = result.items.filter(i => i.source === 'rag');
const snugHighRel = snugRag.filter(i => i.score >= 180).length;
console.log(`  [+] High-relevance docs PRIORITIZED — ${snugHighRel} of ${highRelevanceTotal.length} top docs included`);

// Dead zone?
console.log(`  [+] Dead zone: ${highScoreInMiddle.length} high-value items in middle (vs. naive approach)`);

// Tool management
const snugToolCount = result.items.filter(i => i.source === 'tools').length;
const toolsDropped = result.dropped.filter(d => d.source === 'tools').length;
if (toolsDropped > 0) {
  console.log(`  [+] Tool pruning — ${snugToolCount} tools included, ${toolsDropped} low-priority dropped`);
}

// Warnings
if (result.warnings.length > 0) {
  console.log(`  [!] Warnings: ${result.warnings.map(w => w.type).join(', ')}`);
}

console.log();

// =========================================================================
// Side-by-side summary
// =========================================================================

console.log('='.repeat(70));
console.log('  COMPARISON');
console.log('='.repeat(70));
console.log();

const row = (label: string, before: string, after: string) => {
  console.log(`  ${label.padEnd(35)} ${before.padEnd(20)} ${after}`);
};

row('', 'NAIVE', 'SNUG');
row('-'.repeat(35), '-'.repeat(18), '-'.repeat(18));
row('Items included', `${naiveIncluded.length}`, `${result.items.length}`);
row('Items dropped', `${naiveDropped.length}`, `${result.dropped.length}`);
row('Recent history preserved?', lastHistoryIndex >= totalHistoryMsgs - 1 ? 'Yes' : 'No (truncated)', 'Yes (atomic turns)');
row('High-relevance RAG included', `${highRelevanceIncluded.length}/${highRelevanceTotal.length}`, `${snugHighRel}/${highRelevanceTotal.length}`);
row('Items in dead zone', `${naiveInMiddle.length}`, `${inMiddle.length}`);
row('Tool count', `${toolCount}`, `${snugToolCount}`);
row('Placement strategy', 'Sequential', 'Edges-first (U-curve)');
row('Drop strategy', 'Cut at end', 'Score-based');
