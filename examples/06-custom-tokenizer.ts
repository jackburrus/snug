/**
 * Example 6: Custom tokenizer
 *
 * Shows how to replace the built-in heuristic with an exact tokenizer.
 * Also compares accuracy between the heuristic and a simple word-based
 * tokenizer to illustrate the trade-off.
 *
 * Run: bun examples/06-custom-tokenizer.ts
 */
import { ContextOptimizer, DefaultTokenizer } from '../src/index';

// --- Simulate a custom tokenizer ---
// In production, you'd use tiktoken:
//   import { encoding_for_model } from 'tiktoken';
//   const enc = encoding_for_model('gpt-4o');
//   const tokenizer = { count: (text: string) => enc.encode(text).length };
//
// For this example, we use a rough word-based tokenizer.
const wordTokenizer = {
  count(text: string): number {
    // ~1.3 tokens per word is a common approximation
    const words = text.split(/\s+/).filter(w => w.length > 0);
    return Math.ceil(words.length * 1.3);
  },
};

// --- Test content ---
const systemPrompt = 'You are a senior TypeScript developer. Review code for bugs, performance issues, and style violations. Always explain your reasoning.';

const codeChunks = [
  `function debounce<T extends (...args: any[]) => any>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}`,
  `interface CacheEntry<T> { value: T; expires: number; }
class TTLCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  set(key: string, value: T, ttl: number) {
    this.store.set(key, { value, expires: Date.now() + ttl });
  }
  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry || entry.expires < Date.now()) { this.store.delete(key); return undefined; }
    return entry.value;
  }
}`,
  `async function retry<T>(fn: () => Promise<T>, attempts = 3, delay = 1000): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) { if (i === attempts - 1) throw e; await new Promise(r => setTimeout(r, delay * (i + 1))); }
  }
  throw new Error('unreachable');
}`,
];

// --- Compare: built-in heuristic vs. custom tokenizer ---
const heuristic = new DefaultTokenizer();

console.log('=== Token Count Comparison ===\n');
console.log('Content'.padEnd(25), 'Heuristic'.padEnd(12), 'Word-based'.padEnd(12), 'Difference');
console.log('-'.repeat(65));

for (let i = 0; i < codeChunks.length; i++) {
  const h = heuristic.count(codeChunks[i]!);
  const w = wordTokenizer.count(codeChunks[i]!);
  const diff = ((h - w) / w * 100).toFixed(0);
  console.log(`Code chunk ${i}`.padEnd(25), `${h}`.padEnd(12), `${w}`.padEnd(12), `${diff}%`);
}

const sysH = heuristic.count(systemPrompt);
const sysW = wordTokenizer.count(systemPrompt);
console.log('System prompt'.padEnd(25), `${sysH}`.padEnd(12), `${sysW}`.padEnd(12), `${((sysH - sysW) / sysW * 100).toFixed(0)}%`);

// --- Pack with each tokenizer ---
console.log('\n=== Packing with Built-in Heuristic ===\n');

const optHeuristic = new ContextOptimizer({
  model: 'gpt-4o',
  contextWindow: 300,
  reserveOutput: 50,
});

optHeuristic.add('system', systemPrompt, { priority: 'required', position: 'beginning' });
optHeuristic.add('code', codeChunks, { priority: 'medium' });

const r1 = optHeuristic.pack('Review these functions');
console.log(`Budget: ${r1.stats.budget} tokens`);
console.log(`Packed: ${r1.stats.totalTokens} tokens (${(r1.stats.utilization * 100).toFixed(0)}%)`);
console.log(`Items:  ${r1.items.length} included, ${r1.dropped.length} dropped`);

console.log('\n=== Packing with Word-based Tokenizer ===\n');

const optCustom = new ContextOptimizer({
  model: 'gpt-4o',
  contextWindow: 300,
  reserveOutput: 50,
  tokenizer: wordTokenizer,
});

optCustom.add('system', systemPrompt, { priority: 'required', position: 'beginning' });
optCustom.add('code', codeChunks, { priority: 'medium' });

const r2 = optCustom.pack('Review these functions');
console.log(`Budget: ${r2.stats.budget} tokens`);
console.log(`Packed: ${r2.stats.totalTokens} tokens (${(r2.stats.utilization * 100).toFixed(0)}%)`);
console.log(`Items:  ${r2.items.length} included, ${r2.dropped.length} dropped`);

console.log('\n--- Takeaway ---');
console.log('The heuristic is conservative (over-estimates by ~10-15%).');
console.log('An exact tokenizer fits more content into the same budget.');
console.log('Use tiktoken or gpt-tokenizer for production accuracy.');
