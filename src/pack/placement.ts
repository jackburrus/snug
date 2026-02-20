import type { ContextItem, PackedItem, Placement } from '../types';

/**
 * Position-aware placement based on "Lost in the Middle" research.
 *
 * LLMs attend most to the beginning and end of the context window.
 * This function arranges items to exploit that:
 *
 * - Items with `position: 'beginning'` → pinned at the start (primacy)
 * - Items with `position: 'end'` → pinned at the end (recency)
 * - Floating items (no position) → edges-first by score:
 *   highest-scored items alternate between beginning and end,
 *   pushing lower-scored items toward the middle where attention is weakest.
 */
export function applyPlacement(items: ContextItem[]): PackedItem[] {
  const pinStart: ContextItem[] = [];
  const pinEnd: ContextItem[] = [];
  const query: ContextItem[] = [];
  const float: ContextItem[] = [];

  for (const item of items) {
    // Query is internal — always the very last item
    if (item.source === 'query') query.push(item);
    else if (item.position === 'beginning') pinStart.push(item);
    else if (item.position === 'end') pinEnd.push(item);
    else float.push(item);
  }

  // Pinned items preserve their original source order
  pinStart.sort((a, b) => a.index - b.index);
  pinEnd.sort((a, b) => a.index - b.index);

  // Float items: edges-first placement by score
  float.sort((a, b) => b.score - a.score);
  const floatBeginning: ContextItem[] = [];
  const floatMiddle: ContextItem[] = [];

  for (let i = 0; i < float.length; i++) {
    if (i % 2 === 0) {
      floatBeginning.push(float[i]!);
    } else {
      floatMiddle.push(float[i]!);
    }
  }
  // Reverse middle so lowest-scored items cluster at the center
  floatMiddle.reverse();

  const result: PackedItem[] = [];

  const push = (arr: ContextItem[], placement: Placement) => {
    for (const item of arr) {
      const packed: PackedItem = {
        id: item.id,
        source: item.source,
        content: item.content,
        value: item.value,
        tokens: item.tokens,
        score: item.score,
        placement,
      };
      if (item.role != null) {
        packed.role = item.role;
      }
      result.push(packed);
    }
  };

  push(pinStart, 'beginning');
  push(floatBeginning, 'beginning');
  push(floatMiddle, 'middle');
  push(pinEnd, 'end');
  push(query, 'end');

  return result;
}
