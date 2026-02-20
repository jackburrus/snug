import type { ContextItem } from '../types';

/**
 * A constraint declares that if one item is included, another must be too.
 *
 * Example: if tool "search" is included, its few-shot example must also be.
 */
export interface Constraint {
  /** The item ID that triggers this constraint. */
  ifIncluded: string;
  /** The item ID that must also be included. */
  thenRequire: string;
}

/**
 * Enforce dependency constraints on a set of included items.
 *
 * If an included item triggers a constraint, the required dependency is pulled
 * from the `available` pool. If adding the dependency would exceed the budget,
 * the *triggering* item is removed instead (since its constraint can't be met).
 *
 * Loops until stable to handle transitive dependencies (A→B→C). A `failedDeps`
 * set prevents infinite loops by tracking dependencies that could not be resolved.
 *
 * Mutates and returns the included array.
 */
export function enforceConstraints(
  included: ContextItem[],
  available: ContextItem[],
  constraints: Constraint[],
  budget: number,
): { included: ContextItem[]; added: ContextItem[]; removed: ContextItem[] } {
  if (constraints.length === 0) return { included, added: [], removed: [] };

  const includedIds = new Set(included.map(i => i.id));
  const availableMap = new Map(available.map(i => [i.id, i]));
  const added: ContextItem[] = [];
  const removed: ContextItem[] = [];
  const failedDeps = new Set<string>();

  let currentTokens = included.reduce((sum, i) => sum + i.tokens, 0);
  let changed = true;

  while (changed) {
    changed = false;

    for (const constraint of constraints) {
      if (!includedIds.has(constraint.ifIncluded)) continue;
      if (includedIds.has(constraint.thenRequire)) continue;
      if (failedDeps.has(constraint.thenRequire)) {
        // Already failed — remove trigger if still present
        const triggerIdx = included.findIndex(i => i.id === constraint.ifIncluded);
        if (triggerIdx !== -1 && included[triggerIdx]!.priority !== 'required') {
          const [trigger] = included.splice(triggerIdx, 1);
          includedIds.delete(trigger!.id);
          currentTokens -= trigger!.tokens;
          removed.push(trigger!);
          changed = true;
        }
        continue;
      }

      const dep = availableMap.get(constraint.thenRequire);
      if (!dep) {
        // Dependency doesn't exist in available pool — can't satisfy
        failedDeps.add(constraint.thenRequire);
        changed = true;
        continue;
      }

      if (currentTokens + dep.tokens <= budget) {
        // Dependency fits — add it
        included.push(dep);
        includedIds.add(dep.id);
        availableMap.delete(dep.id);
        currentTokens += dep.tokens;
        added.push(dep);
        changed = true;
      } else {
        // Dependency doesn't fit — remove the trigger instead
        failedDeps.add(constraint.thenRequire);
        const triggerIdx = included.findIndex(i => i.id === constraint.ifIncluded);
        if (triggerIdx !== -1 && included[triggerIdx]!.priority !== 'required') {
          const [trigger] = included.splice(triggerIdx, 1);
          includedIds.delete(trigger!.id);
          currentTokens -= trigger!.tokens;
          removed.push(trigger!);
        }
        changed = true;
      }
    }
  }

  return { included, added, removed };
}
