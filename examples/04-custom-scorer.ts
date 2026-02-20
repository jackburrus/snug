/**
 * Example 4: Custom scorer — keyword-based relevance
 *
 * Shows how to use the `scorer` option to implement your own
 * relevance ranking. In production you'd use embeddings; here
 * we use a simple keyword overlap for demonstration.
 *
 * Run: bun examples/04-custom-scorer.ts
 */
import { ContextOptimizer } from '../src/index';
import type { ContextItem } from '../src/index';

// --- Simple keyword relevance scorer ---

function keywordScorer(item: ContextItem, query: string): number {
  const queryWords = new Set(
    query.toLowerCase().split(/\W+/).filter(w => w.length > 2)
  );
  const contentWords = item.content.toLowerCase().split(/\W+/);

  let matches = 0;
  for (const word of contentWords) {
    if (queryWords.has(word)) matches++;
  }

  // Normalize: 0-100 scale based on match density
  const density = contentWords.length > 0 ? matches / contentWords.length : 0;
  return Math.min(100, density * 500);
}

// --- Set up optimizer ---

const optimizer = new ContextOptimizer({
  model: 'claude-sonnet-4-20250514',
  contextWindow: 2_000,   // Small budget to force interesting decisions
  reserveOutput: 500,
});

optimizer.add('system', 'You are a technical documentation assistant.', {
  priority: 'required',
  position: 'beginning',
});

// 8 RAG chunks — only some are relevant to the query
const docs = [
  'Authentication: The auth module uses JWT tokens stored in httpOnly cookies. Tokens expire after 24 hours and are refreshed automatically on each request.',
  'Database: PostgreSQL is used as the primary database. Migrations are managed with Drizzle ORM. Connection pooling is handled by pg-pool with a max of 20 connections.',
  'Caching: Redis is used for session storage and response caching. Cache invalidation follows a write-through pattern. TTL defaults to 1 hour.',
  'Deployment: The application is deployed to AWS ECS using Fargate. CI/CD runs through GitHub Actions. Staging deploys on every PR merge.',
  'API Rate Limiting: Rate limits are enforced per-API-key using a sliding window algorithm. Default: 100 requests per minute. Enterprise keys get 1000/min.',
  'WebSocket: Real-time features use WebSocket connections managed by Socket.io. Events are broadcast through Redis pub/sub for horizontal scaling.',
  'Logging: Structured JSON logging via Pino. Logs are shipped to Datadog. Request IDs are propagated through the X-Request-ID header.',
  'Testing: Unit tests use Vitest. Integration tests use Testcontainers for database and Redis dependencies. Coverage threshold is 80%.',
];

optimizer.add('docs', docs, {
  priority: 'medium',
  scorer: keywordScorer,
});

const query = 'How does Redis caching work with the database?';
const result = optimizer.pack(query);

// --- Print results ---

console.log('=== Custom Scorer Demo ===\n');
console.log(`Query: "${query}"\n`);
console.log(`Budget: ${result.stats.budget.toLocaleString()} tokens`);
console.log(`Packed: ${result.stats.totalTokens.toLocaleString()} tokens\n`);

console.log('--- Included (by relevance) ---');
const docItems = result.items.filter(i => i.source === 'docs');
for (const item of docItems) {
  const preview = item.content.slice(0, 80);
  console.log(`  score=${item.score.toFixed(1).padStart(5)}  ${preview}...`);
}

console.log(`\n--- Dropped (${result.dropped.filter(d => d.source === 'docs').length} docs) ---`);
for (const d of result.dropped.filter(d => d.source === 'docs')) {
  console.log(`  score=${d.score.toFixed(1).padStart(5)}  ${d.id}`);
}
