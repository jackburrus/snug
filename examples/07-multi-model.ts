/**
 * Example 7: Multi-model cost comparison
 *
 * Packs the same context for different models and compares token usage,
 * budget utilization, and estimated cost across providers.
 *
 * Run: bun examples/07-multi-model.ts
 */
import { ContextOptimizer } from '../src/index';

const systemPrompt = 'You are a helpful coding assistant. Always explain your reasoning before making changes. Follow the project conventions.';

const tools = [
  { name: 'read_file', description: 'Read a file from the filesystem', parameters: { path: { type: 'string' } } },
  { name: 'write_file', description: 'Write content to a file', parameters: { path: { type: 'string' }, content: { type: 'string' } } },
  { name: 'search', description: 'Search the codebase', parameters: { query: { type: 'string' } } },
  { name: 'run_tests', description: 'Run the test suite', parameters: { filter: { type: 'string' } } },
];

const history = Array.from({ length: 10 }, (_, i) => {
  if (i % 2 === 0) {
    return { role: 'user', content: `Can you look at the auth module? ${'Detailed context about the problem. '.repeat(5)}` };
  }
  return { role: 'assistant', content: `Let me examine that. ${'Here is what I found in the codebase and my analysis. '.repeat(8)}` };
});

const ragChunks = [
  'src/auth/session.ts: export class SessionManager { private store = new Map(); async create(userId) { ... } }',
  'src/auth/middleware.ts: export function authMiddleware(req, res, next) { const token = req.headers.authorization; ... }',
  'src/auth/routes.ts: router.post("/login", async (req, res) => { const { email, password } = req.body; ... })',
  'src/config/database.ts: import { drizzle } from "drizzle-orm/node-postgres"; export const db = drizzle(process.env.DATABASE_URL!);',
];

// --- Define models ---
const models = [
  { model: 'claude-sonnet-4-20250514', contextWindow: 200_000, reserveOutput: 8_192, pricing: { inputPer1M: 3, provider: 'anthropic' } },
  { model: 'claude-haiku-3.5',         contextWindow: 200_000, reserveOutput: 4_096, pricing: { inputPer1M: 0.8, provider: 'anthropic' } },
  { model: 'gpt-4o',                   contextWindow: 128_000, reserveOutput: 4_096, pricing: { inputPer1M: 2.5, provider: 'openai' } },
  { model: 'gpt-4o-mini',              contextWindow: 128_000, reserveOutput: 4_096, pricing: { inputPer1M: 0.15, provider: 'openai' } },
  { model: 'gemini-2.0-flash',         contextWindow: 1_000_000, reserveOutput: 8_192, pricing: { inputPer1M: 0.1, provider: 'google' } },
];

const query = 'Now refactor the session manager to use Redis instead of the in-memory Map';

console.log('=== Multi-Model Context Comparison ===\n');
console.log(
  'Model'.padEnd(28),
  'Window'.padEnd(12),
  'Budget'.padEnd(12),
  'Packed'.padEnd(10),
  'Used'.padEnd(8),
  'Dropped'.padEnd(10),
  'Cost',
);
console.log('-'.repeat(95));

for (const config of models) {
  const opt = new ContextOptimizer(config);

  opt.add('system', systemPrompt, { priority: 'required', position: 'beginning' });
  opt.add('tools', tools, { priority: 'high' });
  opt.add('history', history, { priority: 'high', keepLast: 2, dropStrategy: 'oldest', position: 'end', groupBy: 'turn' });
  opt.add('rag', ragChunks, { priority: 'medium' });

  const result = opt.pack(query);

  console.log(
    config.model.padEnd(28),
    `${(config.contextWindow / 1000).toFixed(0)}K`.padEnd(12),
    `${result.stats.budget.toLocaleString()}`.padEnd(12),
    `${result.stats.totalTokens.toLocaleString()}`.padEnd(10),
    `${(result.stats.utilization * 100).toFixed(1)}%`.padEnd(8),
    `${result.dropped.length}`.padEnd(10),
    result.stats.estimatedCost?.input ?? 'N/A',
  );
}

console.log('\n--- Insight ---');
console.log('Same context, different economics. The content fits easily in all models,');
console.log('but cost varies 30x between Gemini Flash ($0.10/M) and Sonnet ($3/M).');
console.log('Use this to decide when a cheaper model is sufficient for the task.');
