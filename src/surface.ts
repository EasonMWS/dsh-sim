import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';

export const PREVENTED = 'SIM_PREVENTED_RETRY';
const opening = '[SIM] 已注入 1 条历史防复发经验';
const closing = '\n[SIM:end]';

export function wrapHint(text: string): string { return text + closing; }

export function containsHint(content: readonly ContentBlock[]): boolean {
  return content.some((block) => block.type === 'text' && block.text.includes(opening) && block.text.includes(closing));
}

function unadorn(event: SessionEvent<'tool/result'>): ContentBlock[] | undefined {
  let removed = false;
  const content = event.data.message.content.flatMap((block): ContentBlock[] => {
    if (block.type !== 'text') return [block];
    const start = block.text.lastIndexOf(opening);
    const end = block.text.lastIndexOf(closing);
    if (start < 0 || end <= start) return [block];
    removed = true;
    if (event.data.error?.code === PREVENTED) {
      return [{ ...block, text: 'Error: tool call skipped before execution.' }];
    }
    const remaining = block.text.slice(0, start).replace(/\n\n$/, '') + block.text.slice(end + closing.length);
    return remaining ? [{ ...block, text: remaining }] : [];
  });
  return removed ? content : undefined;
}

export function retireHints(session: Session, keep?: { turn: number; step: number }): number {
  let retained = 0;
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq);
    if (event?.type !== 'tool/result') continue;
    if (keep && keep.turn === event.data.turn && keep.step === event.data.step) {
      if (containsHint(event.data.message.content)) retained++;
      continue;
    }
    const content = unadorn(event);
    if (!content) continue;
    // The built-in positional replacement retains the unmodified tool/card
    // history and can be replayed after SIM has been uninstalled.
    session.append('tool/result', { ...event.data, message: { ...event.data.message, content } }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    });
  }
  return retained;
}
