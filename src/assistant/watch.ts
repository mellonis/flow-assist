// Watching a child (AGENTS.md (watching a child)): the words and labels the chat draws around
// a watched node's rows. Pure; the chat owns the watch and draws what these return.
import type { Conversation } from './conversation.js';
import type { TreeNode } from './conversation-types.js';
import { endedVerdict, nodeState } from './agent-tree.js';

// The labels from the session's child down to `node`, read from `parent`: the frame title's
// breadcrumb. The session itself, which has no parent, is not a label.
export function watchPath(node: Pick<Conversation, 'label' | 'parent'>): string[] {
  const out: string[] = [];
  for (let c: Pick<Conversation, 'label' | 'parent'> | null = node; c?.parent; c = c.parent) out.push(c.label);
  return out.reverse();
}

// How a watched node ended, as a listing words it: its last turn's outcome, else `stopped`
// for a node closed with the conversation that held it, else `failed`.
export function endedWord(end: { outcome: string } | null, closeReason: string | null): string {
  if (closeReason === 'parent' || closeReason === 'exit') return endedVerdict('stopped');
  return endedVerdict(end?.outcome ?? 'failed');
}

// The hint row's left text: what the node does as its tree row says it, or, once it ended,
// `ended: <verdict>`. `node` is the node's tree entry (undefined once it left the tree).
export function watchState(node: TreeNode | undefined, ended: string | null, now = Date.now()): string {
  if (ended !== null) return `ended: ${ended}`;
  return node ? nodeState(node, now) : '';
}
