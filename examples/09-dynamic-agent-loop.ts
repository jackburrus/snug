/**
 * Example 9: Dynamic agent loop
 *
 * Simulates a real agent loop where history grows each turn.
 * Shows how snug handles re-packing as context accumulates,
 * and how turn grouping keeps conversations coherent.
 *
 * Run: bun examples/09-dynamic-agent-loop.ts
 */
import { ContextOptimizer } from '../src/index';

const optimizer = new ContextOptimizer({
  model: 'claude-sonnet-4-20250514',
  contextWindow: 1_000,  // artificially small to force drops
  reserveOutput: 200,
  pricing: { inputPer1M: 3, provider: 'anthropic' },
});

// Fixed context — registered once
optimizer.add('system', 'You are a coding assistant. Be concise.', {
  priority: 'required',
  position: 'beginning',
});

optimizer.add('tools', [
  { name: 'read_file', description: 'Read a file' },
  { name: 'write_file', description: 'Write a file' },
  { name: 'search', description: 'Search code' },
], { priority: 'high' });

// --- Simulate an agent conversation ---
const conversation: { role: string; content: string }[] = [];

const turns = [
  { user: 'Find the auth bug in session.ts', assistant: 'Let me search for session.ts and read it.' },
  { user: 'What did you find?', assistant: 'The session expiry check is missing. Tokens never expire.' },
  { user: 'Fix it — add a 24-hour TTL', assistant: 'Done. I added an expiresAt field and a check in validate().' },
  { user: 'Now add a refresh endpoint', assistant: 'Created POST /refresh that extends the session by 24 hours.' },
  { user: 'Write tests for the refresh endpoint', assistant: 'Added 3 tests: valid refresh, expired token, and invalid token.' },
  { user: 'Run the tests', assistant: 'All 3 tests pass. The auth module is now complete.' },
];

console.log('=== Dynamic Agent Loop ===\n');
console.log('Simulating 6 conversation turns with a tiny 1K token budget.\n');

for (let i = 0; i < turns.length; i++) {
  const turn = turns[i]!;

  // Add messages to conversation
  conversation.push({ role: 'user', content: turn.user });
  conversation.push({ role: 'assistant', content: turn.assistant });

  // Re-register history with current conversation (replaces previous)
  optimizer.add('history', conversation, {
    priority: 'high',
    keepLast: 1,           // current turn is always required
    dropStrategy: 'oldest',
    position: 'end',
    groupBy: 'turn',
  });

  // Pack with the user's latest message as the query
  const result = optimizer.pack(turn.user);

  const historyItems = result.items.filter(it => it.source === 'history');
  const historyDropped = result.dropped.filter(d => d.source === 'history');

  console.log(`Turn ${i + 1}: "${turn.user}"`);
  console.log(`  Tokens: ${result.stats.totalTokens}/${result.stats.budget} (${(result.stats.utilization * 100).toFixed(0)}%)`);
  console.log(`  History: ${historyItems.length} turns included, ${historyDropped.length} dropped`);

  if (historyItems.length > 0) {
    const turnIds = historyItems.map(it => it.id).join(', ');
    console.log(`  Included: ${turnIds}`);
  }
  if (historyDropped.length > 0) {
    const droppedIds = historyDropped.map(d => d.id).join(', ');
    console.log(`  Dropped:  ${droppedIds}`);
  }
  console.log();
}

console.log('--- Takeaway ---');
console.log('As conversation grows, old turns are automatically dropped.');
console.log('The last turn is always preserved (keepLast: 1).');
console.log('Turn grouping keeps user+assistant messages together.');
