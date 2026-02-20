/**
 * Example 11: Context window visualization
 *
 * Renders an ASCII map of the context window showing where each item
 * lands relative to the U-shaped attention curve. Makes the
 * lost-in-the-middle effect visible.
 *
 * Run: bun examples/11-visualize-context.ts
 */
import { ContextOptimizer } from '../src/index';

// --- Build a realistic context ---

const optimizer = new ContextOptimizer({
  model: 'claude-sonnet-4-20250514',
  contextWindow: 2_000,
  reserveOutput: 400,
});

optimizer.add('system', 'You are a senior TypeScript engineer reviewing a pull request.', {
  priority: 'required',
  position: 'beginning',
});

optimizer.add('tools', [
  { name: 'read_file', description: 'Read a file from the filesystem' },
  { name: 'write_file', description: 'Write content to a file' },
  { name: 'search', description: 'Search the codebase with a regex pattern' },
  { name: 'run_tests', description: 'Run the test suite' },
], { priority: 'high' });

optimizer.add('history', [
  { role: 'user', content: 'Can you review the auth module changes?' },
  { role: 'assistant', content: 'Sure, let me look at the diff. I see changes to session.ts and middleware.ts.' },
  { role: 'user', content: 'Focus on the session expiry logic — that is the critical part.' },
  { role: 'assistant', content: 'The session expiry check has a bug. It compares timestamps incorrectly.' },
  { role: 'user', content: 'Can you fix it and add tests?' },
  { role: 'assistant', content: 'Done. I fixed the comparison and added 3 test cases for edge conditions.' },
], {
  priority: 'high',
  keepLast: 1,
  dropStrategy: 'oldest',
  position: 'end',
  groupBy: 'turn',
});

optimizer.add('rag', [
  'src/auth/session.ts: export class SessionManager { validate(token) { if (session.expiresAt < Date.now()) ... } }',
  'src/auth/middleware.ts: export function authMiddleware(req, res, next) { const session = validate(token); ... }',
  'src/auth/session.test.ts: describe("SessionManager", () => { test("expires after TTL") ... })',
  'src/types/session.ts: export interface Session { token: string; userId: string; expiresAt: number; }',
  'docs/auth.md: # Authentication — Sessions use JWT tokens with 24-hour expiry. Refresh via POST /refresh.',
], { priority: 'medium' });

const result = optimizer.pack('Review the session expiry fix and verify the tests cover edge cases');

// --- Visualization ---

const WIDTH = 70;
const ATTENTION_CHARS = 50; // width of the attention bar

// U-shaped attention: high at edges, low in middle
function attention(position: number): number {
  // Parabolic U-curve: 1.0 at edges, ~0.3 at center
  const x = position * 2 - 1; // map [0,1] to [-1,1]
  return 0.3 + 0.7 * x * x;
}

function attentionBar(level: number, width: number): string {
  const filled = Math.round(level * width);
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
  return bar;
}

function attentionLabel(level: number): string {
  if (level >= 0.8) return 'HIGH';
  if (level >= 0.5) return 'MED ';
  return 'LOW ';
}

console.log();
console.log('='.repeat(WIDTH));
console.log('  CONTEXT WINDOW MAP');
console.log('  U-shaped attention curve + item placement');
console.log('='.repeat(WIDTH));
console.log();
console.log(`  Budget: ${result.stats.budget} tokens | Used: ${result.stats.totalTokens} tokens (${(result.stats.utilization * 100).toFixed(0)}%)`);
console.log(`  Items: ${result.items.length} included | Dropped: ${result.dropped.length}`);
console.log();

// Build position map
const totalTokens = result.stats.totalTokens;
let runningTokens = 0;

interface PlacedItem {
  id: string;
  source: string;
  tokens: number;
  score: number;
  placement: string;
  startPos: number; // 0-1 normalized
  endPos: number;
  midPos: number;
}

const placed: PlacedItem[] = result.items.map(item => {
  const startPos = runningTokens / totalTokens;
  runningTokens += item.tokens;
  const endPos = runningTokens / totalTokens;
  return {
    id: item.id,
    source: item.source,
    tokens: item.tokens,
    score: item.score,
    placement: item.placement,
    startPos,
    endPos,
    midPos: (startPos + endPos) / 2,
  };
});

// Print the context window
console.log('  Position   Attention  Source/Item');
console.log('  ' + '-'.repeat(WIDTH - 4));

for (const item of placed) {
  const att = attention(item.midPos);
  const attLabel = attentionLabel(att);
  const pctLabel = `${(item.midPos * 100).toFixed(0)}%`.padStart(4);
  const bar = attentionBar(att, 15);
  const scoreLabel = item.score === Infinity ? 'REQ' : `${item.score.toFixed(0)}`;
  const label = `${item.source}/${item.id}`;
  const truncLabel = label.length > 30 ? label.slice(0, 27) + '...' : label;

  console.log(`  ${pctLabel} ${attLabel} ${bar}  ${truncLabel.padEnd(30)} ${item.tokens}tok  score=${scoreLabel}`);
}

console.log('  ' + '-'.repeat(WIDTH - 4));

// Print the attention curve legend
console.log();
console.log('  ATTENTION CURVE (U-shaped):');
console.log();

const CURVE_HEIGHT = 8;
const CURVE_WIDTH = 50;

for (let row = CURVE_HEIGHT; row >= 0; row--) {
  const threshold = row / CURVE_HEIGHT;
  let line = '  ';
  if (row === CURVE_HEIGHT) line += '100%|';
  else if (row === 0) line += '  0%|';
  else if (row === Math.floor(CURVE_HEIGHT * 0.3)) line += ' 30%|';
  else line += '    |';

  for (let col = 0; col < CURVE_WIDTH; col++) {
    const pos = col / (CURVE_WIDTH - 1);
    const att = attention(pos);
    if (att >= threshold) {
      line += '\u2588';
    } else {
      line += ' ';
    }
  }
  console.log(line);
}
console.log('     +' + '-'.repeat(CURVE_WIDTH));
console.log('     START' + ' '.repeat(CURVE_WIDTH - 12) + 'END');
console.log('     (primacy)' + ' '.repeat(CURVE_WIDTH - 22) + '(recency)');

// --- Zone analysis ---
console.log();
console.log('  ZONE ANALYSIS:');
console.log();

const zones = {
  beginning: placed.filter(i => i.midPos < 0.3),
  middle: placed.filter(i => i.midPos >= 0.3 && i.midPos <= 0.7),
  end: placed.filter(i => i.midPos > 0.7),
};

const zoneLabel = (name: string, items: PlacedItem[], attRange: string) => {
  const sources = [...new Set(items.map(i => i.source))];
  const highValue = items.filter(i => i.score >= 80 || i.score === Infinity);
  console.log(`  ${name} (attention ${attRange}):`);
  console.log(`    ${items.length} items — ${sources.join(', ')}`);
  if (highValue.length > 0) {
    console.log(`    ${highValue.length} high-value items in this zone`);
  }
  console.log();
};

zoneLabel('BEGINNING (0-30%)', zones.beginning, '70-100%');
zoneLabel('MIDDLE (30-70%)', zones.middle, '30-50%');
zoneLabel('END (70-100%)', zones.end, '70-100%');

// Key insight
const highValueInMiddle = zones.middle.filter(i => i.score >= 80 || i.score === Infinity);
if (highValueInMiddle.length === 0) {
  console.log('  Result: No high-value items in the dead zone. snug placed them at the edges');
  console.log('  where LLM attention is strongest.');
} else {
  console.log(`  Warning: ${highValueInMiddle.length} high-value item(s) in the dead zone.`);
  console.log('  Consider using position: "beginning" or "end" for these sources.');
}

// --- Dropped items ---
if (result.dropped.length > 0) {
  console.log();
  console.log('  DROPPED (excluded from context):');
  for (const d of result.dropped) {
    console.log(`    ${d.source}/${d.id} — ${d.tokens}tok, score=${d.score.toFixed(0)} — ${d.reason}`);
  }
}
console.log();
