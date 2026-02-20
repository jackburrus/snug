/**
 * Example 3: Tight budget — small model, lots of context
 *
 * Demonstrates what happens when you have more context than fits.
 * This is the scenario where snug shines — you see exactly what
 * gets cut and why.
 *
 * Run: bun examples/03-tight-budget.ts
 */
import { ContextOptimizer } from '../src/index';

const optimizer = new ContextOptimizer({
  model: 'gpt-4o-mini',
  contextWindow: 4_000,   // Simulate a tight window
  reserveOutput: 1_000,   // Reserve 1K for output
  pricing: { inputPer1M: 0.15, provider: 'openai' },
});

// System prompt — required, always in
optimizer.add('system', 'You are a customer support agent for Acme Corp. Be helpful and concise. Always reference the customer\'s order number.', {
  priority: 'required',
  position: 'beginning',
});

// 12 tools — deliberately too many (triggers tool-overload warning)
const tools = [
  { name: 'lookup_order', description: 'Look up an order by order number' },
  { name: 'lookup_customer', description: 'Look up a customer by email' },
  { name: 'issue_refund', description: 'Issue a refund for an order' },
  { name: 'create_ticket', description: 'Create a support ticket' },
  { name: 'escalate_ticket', description: 'Escalate a ticket to a manager' },
  { name: 'send_email', description: 'Send an email to a customer' },
  { name: 'check_inventory', description: 'Check product inventory' },
  { name: 'apply_discount', description: 'Apply a discount to an order' },
  { name: 'cancel_order', description: 'Cancel an order' },
  { name: 'track_shipment', description: 'Track a shipment' },
  { name: 'update_address', description: 'Update shipping address' },
  { name: 'view_returns', description: 'View return requests' },
];
optimizer.add('tools', tools, { priority: 'high' });

// Long conversation history — most of this will get dropped
const history = [
  { role: 'user', content: 'Hi, I need help with my order' },
  { role: 'assistant', content: 'Hello! I\'d be happy to help. Could you provide your order number?' },
  { role: 'user', content: 'It\'s ORD-2024-9876' },
  { role: 'assistant', content: 'Thank you! Let me look that up. I can see order ORD-2024-9876 was placed on January 15th for a Widget Pro (x2) and a Gadget Plus (x1), totaling $247.50. The order shipped on January 17th via FedEx.' },
  { role: 'user', content: 'The Widget Pro arrived damaged. The box was crushed and one unit is cracked.' },
  { role: 'assistant', content: 'I\'m sorry to hear that. I can see the shipment was delivered on January 20th. For a damaged item, I can offer you either a replacement shipment or a full refund for the damaged unit. Which would you prefer?' },
  { role: 'user', content: 'I\'d like a replacement please' },
  { role: 'assistant', content: 'I\'ve initiated a replacement shipment for 1x Widget Pro. You should receive a shipping confirmation email within 24 hours. The replacement will be shipped via FedEx Express at no additional cost. Is there anything else I can help with?' },
  { role: 'user', content: 'Actually, I also wanted to ask about the Gadget Plus. Can I return it?' },
  { role: 'assistant', content: 'Of course! The Gadget Plus from order ORD-2024-9876 is within our 30-day return window. I can generate a prepaid return label for you. Once we receive the item, we\'ll process a refund of $89.99 to your original payment method within 3-5 business days.' },
];
optimizer.add('history', history, { priority: 'high', keepLast: 2, dropStrategy: 'oldest', position: 'end' });

// Customer context from CRM
const memory = [
  'Customer: Jane Smith (jane@example.com), Premium tier, member since 2022',
  'Order ORD-2024-9876: 2x Widget Pro ($78.75 each), 1x Gadget Plus ($89.99), shipped 2024-01-17',
  'Previous interactions: 3 tickets, all resolved, avg satisfaction 4.8/5',
  'Preferences: Prefers email communication, opted into marketing',
];
optimizer.add('memory', memory, { priority: 'medium' });

const result = optimizer.pack('Actually, can I get a refund instead of the return?');

// --- Print results ---

console.log('=== Tight Budget Scenario ===\n');
console.log(`Model:   gpt-4o-mini (4K context)`);
console.log(`Budget:  ${result.stats.budget.toLocaleString()} tokens`);
console.log(`Packed:  ${result.stats.totalTokens.toLocaleString()} tokens`);
console.log(`Used:    ${(result.stats.utilization * 100).toFixed(1)}%`);
if (result.stats.estimatedCost) {
  console.log(`Cost:    ${result.stats.estimatedCost.input}`);
}

console.log('\n--- What Made It In ---');
for (const item of result.items) {
  const preview = item.content.slice(0, 70).replace(/\n/g, ' ');
  console.log(`  [${item.placement.padEnd(9)}] ${item.source}/${item.id} (${item.tokens} tok)`);
  console.log(`             ${preview}...`);
}

console.log(`\n--- What Got Cut (${result.dropped.length} items) ---`);
for (const d of result.dropped) {
  console.log(`  ${d.source}/${d.id} — ${d.tokens} tok, score=${d.score.toFixed(1)} — ${d.reason}`);
}

console.log('\n--- Warnings ---');
if (result.warnings.length === 0) {
  console.log('  (none)');
} else {
  for (const w of result.warnings) {
    console.log(`  [${w.type}] ${w.message}`);
  }
}

console.log('\n--- Breakdown ---');
for (const [source, info] of Object.entries(result.stats.breakdown)) {
  const parts = [`${info.items} in`];
  if (info.dropped) parts.push(`${info.dropped} dropped`);
  parts.push(`${info.tokens} tok`);
  if (info.reason) parts.push(`reason: ${info.reason}`);
  console.log(`  ${source.padEnd(10)} ${parts.join(', ')}`);
}
