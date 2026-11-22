import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';

export const PREVENTED = 'SIM_PREVENTED_RETRY';
export const HINT_OPEN = '[SIM] ';
export const HINT_END = '\n[SIM:end]';

export function wrapHint(text: string): string { return text + HINT_END; }

export function containsHint(content: readonly ContentBlock[]): boolean {
  return content.some((block) => block.type === 'text' && block.text.includes(HINT_OPEN) && block.text.includes(HINT_END));
}

function unadorn(event: SessionEvent<'tool/result'>): ContentBlock[] | undefined {
  let removed = false;
  const content = event.data.message.content.flatMap((block): ContentBlock[] => {
    if (block.type !== 'text') return [block];
    const end = block.text.lastIndexOf(HINT_END);
    // The opening marker belongs at the start of the result, or immediately
    // after the paragraph separator inserted by appendHint.
    const separator = block.text.lastIndexOf(`\n\n${HINT_OPEN}`, end);
    const prevented = event.data.error?.code === PREVENTED;
    const start = separator >= 0 ? separator + 2 : block.text.startsWith(HINT_OPEN) ? 0 :
      prevented && block.text.startsWith(`Error: ${HINT_OPEN}`) ? 7 : -1;
    if (start < 0 || end <= start) return [block];
    removed = true;
    if (prevented) {
      return [{ ...block, text: 'Error: tool call skipped before execution.' }];
    }
    const remaining = block.text.slice(0, start).replace(/\n\n$/, '') + block.text.slice(end + HINT_END.length);
    return remaining ? [{ ...block, text: remaining }] : [];
  });
  return removed ? content : undefined;
}

export function retireHints(session: Session, events: Iterable<SessionEvent<'tool/result'>>): void {
  const active = new Set(session.surface.nodes);
  for (const event of events) {
    const { seq } = event;
    if (!active.has(seq)) continue;
    const content = unadorn(event);
    if (!content) continue;
    // The built-in positional replacement retains the unmodified tool/card
    // history and can be replayed after SIM has been uninstalled.
    session.append('tool/result', { ...event.data, message: { ...event.data.message, content } }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    });
  }
}
