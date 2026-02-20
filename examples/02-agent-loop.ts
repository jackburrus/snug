/**
 * Example 2: Agent loop simulation
 *
 * Simulates a coding agent with tools, conversation history, RAG chunks,
 * and memory — the kind of setup where context management matters most.
 *
 * Run: bun examples/02-agent-loop.ts
 */
import { ContextOptimizer } from '../src/index';

const SYSTEM_PROMPT = `You are an expert coding assistant. You have access to tools for reading files, writing files, and searching the codebase. Always explain your reasoning before making changes. Follow the user's coding style.`;

const tools = [
  { name: 'read_file', description: 'Read a file from the filesystem', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Write content to a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'search', description: 'Search the codebase with a regex pattern', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  { name: 'run_tests', description: 'Run the test suite', parameters: { type: 'object', properties: { filter: { type: 'string' } } } },
  { name: 'lint', description: 'Run the linter on a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];

// Simulated 20-turn conversation history
const history = Array.from({ length: 20 }, (_, i) => {
  const turn = Math.floor(i / 2);
  if (i % 2 === 0) {
    return { role: 'user', content: `Turn ${turn}: Can you look at the auth module and fix the session handling? `.repeat(3) };
  }
  return { role: 'assistant', content: `Turn ${turn}: I'll examine the auth module. Let me read the relevant files first. Here's what I found... `.repeat(5) };
});

// Simulated memory from previous sessions
const memory = [
  'Project uses Express.js with TypeScript',
  'Auth module is in src/auth/ with JWT-based sessions',
  'User prefers async/await over callbacks',
  'Test framework is vitest, run with `bun test`',
  'Database is PostgreSQL via Drizzle ORM',
];

// Simulated RAG chunks from codebase search
const ragChunks = [
  'src/auth/session.ts:\n```typescript\nexport class SessionManager {\n  private store: Map<string, Session> = new Map();\n  async create(userId: string): Promise<Session> {\n    const token = crypto.randomUUID();\n    const session = { token, userId, createdAt: Date.now() };\n    this.store.set(token, session);\n    return session;\n  }\n  async validate(token: string): Promise<Session | null> {\n    return this.store.get(token) ?? null;\n  }\n}\n```',
  'src/auth/middleware.ts:\n```typescript\nexport function authMiddleware(req: Request, res: Response, next: NextFunction) {\n  const token = req.headers.authorization?.replace("Bearer ", "");\n  if (!token) return res.status(401).json({ error: "Unauthorized" });\n  const session = sessionManager.validate(token);\n  if (!session) return res.status(401).json({ error: "Invalid session" });\n  req.user = session.userId;\n  next();\n}\n```',
  'src/auth/routes.ts:\n```typescript\nrouter.post("/login", async (req, res) => {\n  const { email, password } = req.body;\n  const user = await db.query.users.findFirst({ where: eq(users.email, email) });\n  if (!user || !await verify(password, user.passwordHash)) {\n    return res.status(401).json({ error: "Invalid credentials" });\n  }\n  const session = await sessionManager.create(user.id);\n  res.json({ token: session.token });\n});\n```',
  'src/config/database.ts:\n```typescript\nimport { drizzle } from "drizzle-orm/node-postgres";\nexport const db = drizzle(process.env.DATABASE_URL!);\n```',
  'package.json dependencies: express@4.18, drizzle-orm@0.30, jsonwebtoken@9.0, bcrypt@5.1',
  'src/types/session.ts:\n```typescript\nexport interface Session {\n  token: string;\n  userId: string;\n  createdAt: number;\n  expiresAt?: number;\n}\n```',
];

// --- Build the optimized context ---

const optimizer = new ContextOptimizer({
  model: 'claude-sonnet-4-20250514',
  contextWindow: 200_000,
  reserveOutput: 8_192,
  pricing: { inputPer1M: 3, provider: 'anthropic' },
});

optimizer.add('system', SYSTEM_PROMPT, { priority: 'required', position: 'beginning' });
optimizer.add('tools', tools, { priority: 'high' });
optimizer.add('history', history, { priority: 'high', keepLast: 2, dropStrategy: 'oldest', position: 'end', groupBy: 'turn' });
optimizer.add('memory', memory, { priority: 'medium' });
optimizer.add('rag', ragChunks, { priority: 'medium' });

const result = optimizer.pack('Now refactor the session manager to use Redis instead of the in-memory Map');

// --- Print results ---

console.log('=== Agent Context Pack ===\n');

console.log(`Budget: ${result.stats.budget.toLocaleString()} tokens`);
console.log(`Packed: ${result.stats.totalTokens.toLocaleString()} tokens (${(result.stats.utilization * 100).toFixed(1)}% utilization)`);
if (result.stats.estimatedCost) {
  console.log(`Cost:   ${result.stats.estimatedCost.input}`);
}

console.log('\n--- Source Breakdown ---');
for (const [source, info] of Object.entries(result.stats.breakdown)) {
  const parts = [`${info.items} included`, `${info.tokens} tokens`];
  if (info.dropped) parts.push(`${info.dropped} dropped`);
  console.log(`  ${source.padEnd(10)} ${parts.join(', ')}`);
}

console.log(`\n--- Placement Order (${result.items.length} items) ---`);
for (const item of result.items) {
  const tag = `[${item.placement.padEnd(9)}]`;
  const roleTag = item.role ? ` role=${item.role}` : '';
  const isTurn = Array.isArray(item.value) && item.id.includes('_turn_');
  const turnTag = isTurn ? ` (${(item.value as any[]).length} msgs)` : '';
  const preview = item.content.slice(0, 60).replace(/\n/g, ' ');
  console.log(`  ${tag} ${item.source}/${item.id}${roleTag}${turnTag} (${item.tokens} tok) — ${preview}...`);
}

if (result.warnings.length > 0) {
  console.log('\n--- Warnings ---');
  for (const w of result.warnings) console.log(`  ⚠ [${w.type}] ${w.message}`);
}

if (result.dropped.length > 0) {
  console.log(`\n--- Dropped (${result.dropped.length} items) ---`);
  for (const d of result.dropped) {
    console.log(`  ${d.id} (${d.tokens} tok, score=${d.score.toFixed(1)}) — ${d.reason}`);
  }
}
