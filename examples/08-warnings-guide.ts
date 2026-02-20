/**
 * Example 8: Warning types explained
 *
 * Deliberately triggers each warning type so you know what to look for
 * and how to fix it.
 *
 * Run: bun examples/08-warnings-guide.ts
 */
import { ContextOptimizer } from '../src/index';

function printWarnings(label: string, result: ReturnType<InstanceType<typeof ContextOptimizer>['pack']>) {
  console.log(`\n--- ${label} ---`);
  if (result.warnings.length === 0) {
    console.log('  No warnings.');
  }
  for (const w of result.warnings) {
    console.log(`  [${w.type}] ${w.message}`);
  }
}

// ========================================================================
// 1. budget-exceeded
//    Required items alone use more tokens than available budget.
// ========================================================================
console.log('=== Warning Types Guide ===');
console.log('\n1. BUDGET-EXCEEDED');
console.log('   Trigger: Required items exceed the token budget.');
console.log('   Fix: Reduce system prompt size, increase context window, or lower reserveOutput.');

const opt1 = new ContextOptimizer({ model: 'test', contextWindow: 100, reserveOutput: 50 });
opt1.add('system', 'x'.repeat(1000), { priority: 'required', position: 'beginning' });
printWarnings('budget-exceeded', opt1.pack());

// ========================================================================
// 2. tool-overload
//    More than 10 tool definitions included.
// ========================================================================
console.log('\n2. TOOL-OVERLOAD');
console.log('   Trigger: More than 10 tools in context.');
console.log('   Fix: Use a tool selector to include only relevant tools for the current query.');

const opt2 = new ContextOptimizer({ model: 'test', contextWindow: 100_000 });
const manyTools = Array.from({ length: 15 }, (_, i) => ({
  name: `tool_${i}`,
  description: `Tool number ${i} that does something useful`,
}));
opt2.add('tools', manyTools, { priority: 'high' });
printWarnings('tool-overload', opt2.pack());

// ========================================================================
// 3. lost-in-middle
//    High-relevance items placed in the middle 40% of context.
// ========================================================================
console.log('\n3. LOST-IN-MIDDLE');
console.log('   Trigger: High-score items end up in the middle 40% of the context.');
console.log('   Fix: Use position: "beginning" or "end" for important sources.');

const opt3 = new ContextOptimizer({ model: 'test', contextWindow: 10_000 });
// Lots of floating items — some high-score ones will land in the middle
opt3.add('system', 'System prompt.', { priority: 'required', position: 'beginning' });
opt3.add('tools', manyTools.slice(0, 8), { priority: 'high' }); // floating, high score
opt3.add('rag', Array.from({ length: 10 }, (_, i) => `RAG chunk ${i}: some relevant content.`), { priority: 'medium' });
printWarnings('lost-in-middle', opt3.pack('test query'));

// ========================================================================
// 4. high-drop-rate
//    More than 50% of items were dropped.
// ========================================================================
console.log('\n4. HIGH-DROP-RATE');
console.log('   Trigger: Over 50% of registered items were dropped.');
console.log('   Fix: Increase context window, reduce content, or use compression (coming soon).');

const opt4 = new ContextOptimizer({ model: 'test', contextWindow: 200, reserveOutput: 50 });
opt4.add('system', 'Be helpful.', { priority: 'required', position: 'beginning' });
opt4.add('docs', Array.from({ length: 20 }, (_, i) => `Document ${i}: ${'content '.repeat(20)}`), { priority: 'medium' });
printWarnings('high-drop-rate', opt4.pack());

// ========================================================================
// 5. low-utilization
//    Less than 10% of budget used with nothing dropped.
// ========================================================================
console.log('\n5. LOW-UTILIZATION');
console.log('   Trigger: Under 10% of budget used and nothing was dropped.');
console.log('   Fix: Not necessarily a problem, but you could use a smaller context window to save cost.');

const opt5 = new ContextOptimizer({ model: 'test', contextWindow: 200_000 });
opt5.add('system', 'Be helpful.', { priority: 'required', position: 'beginning' });
printWarnings('low-utilization', opt5.pack());

console.log('\n=== Summary ===');
console.log('Warnings are informational — they help you tune your context strategy.');
console.log('Check result.warnings after every pack() call in development.');
