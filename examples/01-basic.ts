/**
 * Example 1: Basic usage
 *
 * Shows the core API — register sources, pack, inspect results.
 *
 * Run: bun examples/01-basic.ts
 */
import { ContextOptimizer } from '../src/index';

const optimizer = new ContextOptimizer({
  model: 'claude-sonnet-4-20250514',
  contextWindow: 200_000,
  reserveOutput: 8_192,
  pricing: { inputPer1M: 3, provider: 'anthropic' },
});

optimizer.add('system', 'You are a helpful assistant that answers questions concisely.', {
  priority: 'required',
  position: 'beginning',
});

optimizer.add('memory', [
  'User prefers TypeScript over JavaScript.',
  'User is building a SaaS product.',
  'User timezone is PST.',
], { priority: 'medium' });

const result = optimizer.pack('How do I set up authentication?');

console.log('--- Packed Items ---');
for (const item of result.items) {
  const preview = item.content.length > 80
    ? item.content.slice(0, 80) + '...'
    : item.content;
  console.log(`  [${item.placement}] ${item.source}/${item.id} (${item.tokens} tokens) — ${preview}`);
}

console.log('\n--- Stats ---');
console.log(`  Budget:      ${result.stats.budget.toLocaleString()} tokens`);
console.log(`  Used:        ${result.stats.totalTokens.toLocaleString()} tokens`);
console.log(`  Utilization: ${(result.stats.utilization * 100).toFixed(1)}%`);
if (result.stats.estimatedCost) {
  console.log(`  Est. cost:   ${result.stats.estimatedCost.input} (${result.stats.estimatedCost.provider})`);
}

console.log('\n--- Breakdown ---');
for (const [source, info] of Object.entries(result.stats.breakdown)) {
  let line = `  ${source}: ${info.tokens} tokens, ${info.items} item(s)`;
  if (info.dropped) line += `, ${info.dropped} dropped`;
  console.log(line);
}

if (result.warnings.length > 0) {
  console.log('\n--- Warnings ---');
  for (const w of result.warnings) console.log(`  [${w.type}] ${w.message}`);
}

if (result.dropped.length > 0) {
  console.log('\n--- Dropped ---');
  for (const d of result.dropped) console.log(`  ${d.id} (${d.tokens} tokens) — ${d.reason}`);
}
