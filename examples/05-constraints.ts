/**
 * Example 5: Dependency constraints
 *
 * Shows how `requires` ensures that tools are always paired with
 * their few-shot examples. If the example can't fit, the tool
 * is removed rather than included without context.
 *
 * Run: bun examples/05-constraints.ts
 */
import { ContextOptimizer } from '../src/index';

const optimizer = new ContextOptimizer({
  model: 'gpt-4o',
  contextWindow: 1_500,
  reserveOutput: 400,
});

optimizer.add('system', 'You are an assistant with access to tools.', {
  priority: 'required',
  position: 'beginning',
});

// Tools — each requires its corresponding example
optimizer.add('tools', [
  { name: 'sql_query', description: 'Execute a SQL query against the database. Returns results as JSON.' },
  { name: 'http_request', description: 'Make an HTTP request to an external API.' },
], {
  priority: 'high',
  requires: {
    'tools_sql_query': 'examples_sql_example',
    'tools_http_request': 'examples_http_example',
  },
});

// Few-shot examples — low priority on their own, but required by tools
optimizer.add('examples', [
  { name: 'sql_example', description: 'Example: To find all users created today, use: sql_query("SELECT * FROM users WHERE created_at >= CURRENT_DATE")' },
  { name: 'http_example', description: 'Example: To fetch weather data, use: http_request({ url: "https://api.weather.gov/points/39.7,-104.9", method: "GET" })' },
], { priority: 'low' });

const result = optimizer.pack('What users signed up this week?');

// --- Print results ---

console.log('=== Constraint Demo ===\n');
console.log(`Budget: ${result.stats.budget} tokens\n`);

console.log('--- Included ---');
for (const item of result.items) {
  console.log(`  ${item.source}/${item.id} (${item.tokens} tok, score=${item.score === Infinity ? '∞' : item.score.toFixed(1)})`);
}

console.log(`\n--- Dropped (${result.dropped.length}) ---`);
for (const d of result.dropped) {
  console.log(`  ${d.source}/${d.id} (${d.tokens} tok) — ${d.reason}`);
}

if (result.warnings.length > 0) {
  console.log('\n--- Warnings ---');
  for (const w of result.warnings) console.log(`  [${w.type}] ${w.message}`);
}

// Show the constraint in action
const includedTools = result.items.filter(i => i.source === 'tools').map(i => i.id);
const includedExamples = result.items.filter(i => i.source === 'examples').map(i => i.id);
console.log('\n--- Constraint Check ---');
if (includedTools.includes('tools_sql_query') && includedExamples.includes('examples_sql_example')) {
  console.log('  sql_query + sql_example: paired correctly');
}
if (includedTools.includes('tools_http_request') && includedExamples.includes('examples_http_example')) {
  console.log('  http_request + http_example: paired correctly');
}
if (!includedTools.includes('tools_http_request') && !includedExamples.includes('examples_http_example')) {
  console.log('  http_request + http_example: both excluded (constraint respected)');
}
