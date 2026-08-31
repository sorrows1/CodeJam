import type { RunUsage, RunnerObservation } from './types.js';

export interface CodexProtocolState {
  currentAssistantMessages: string[];
  legacyAssistantMessages: string[];
  taskCompleteMessage: string | null;
  threadId: string | null;
  legacyUsage: RunUsage | null;
  currentUsage: RunUsage | null;
  taskCompleted: boolean;
  recognizableEventCount: number;
  toolActivitySeen: boolean;
  errors: string[];
}

export function createCodexProtocolState(threadId: string | null = null): CodexProtocolState {
  return {
    currentAssistantMessages: [],
    legacyAssistantMessages: [],
    taskCompleteMessage: null,
    threadId,
    legacyUsage: null,
    currentUsage: null,
    taskCompleted: false,
    recognizableEventCount: 0,
    toolActivitySeen: false,
    errors: [],
  };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

function usage(value: unknown): RunUsage | null {
  if (!record(value)) return null;
  const inputTokens = value.input_tokens;
  const cachedInputTokens = value.cached_input_tokens;
  const outputTokens = value.output_tokens;
  const valid = (candidate: unknown): candidate is number =>
    Number.isSafeInteger(candidate) && (candidate as number) >= 0;
  if (![inputTokens, cachedInputTokens, outputTokens].some(valid)) return null;
  return {
    ...(valid(inputTokens) ? { inputTokens } : {}),
    ...(valid(cachedInputTokens) ? { cachedInputTokens } : {}),
    ...(valid(outputTokens) ? { outputTokens } : {}),
  };
}

function assistantText(payload: Record<string, unknown>): string | null {
  if (payload.role !== 'assistant') return null;
  const direct = nonEmpty(payload.text) ?? nonEmpty(payload.message);
  if (direct) return direct;
  if (!Array.isArray(payload.content)) return null;
  const parts = payload.content.flatMap((part) => {
    if (typeof part === 'string') return part.trim() ? [part.trim()] : [];
    if (!record(part)) return [];
    if (!['text', 'output_text', 'message'].includes(String(part.type ?? ''))) return [];
    const text = nonEmpty(part.text);
    return text ? [text] : [];
  });
  return parts.length ? parts.join('\n') : null;
}

function currentPayload(event: Record<string, unknown>): Record<string, unknown> {
  return event.type === 'event_msg' && record(event.payload) ? event.payload : event;
}

export function consumeCodexProtocolLine(
  line: string,
  state: CodexProtocolState,
): RunnerObservation | null {
  let event: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!record(parsed)) return null;
    event = parsed;
  } catch {
    return null;
  }

  if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
    state.threadId = event.thread_id;
    state.recognizableEventCount += 1;
    return null;
  }
  if (event.type === 'session_meta' && typeof event.id === 'string') {
    state.threadId = event.id;
    state.recognizableEventCount += 1;
    return null;
  }
  if (event.type === 'item.completed' && record(event.item)) {
    state.recognizableEventCount += 1;
    if (event.item.type === 'agent_message') {
      const message = nonEmpty(event.item.text);
      if (message) state.legacyAssistantMessages.push(message);
    }
    return null;
  }
  if (event.type === 'turn.completed') {
    state.recognizableEventCount += 1;
    state.taskCompleted = true;
    state.legacyUsage = usage(event.usage);
    return state.legacyUsage ? { kind: 'usage', usage: state.legacyUsage } : null;
  }
  if (event.type === 'error') {
    state.recognizableEventCount += 1;
    state.errors.push(
      nonEmpty(event.message) ?? nonEmpty(event.error) ?? 'Codex reported an unknown error',
    );
    return null;
  }

  if (event.type === 'response_item' && record(event.payload)) {
    state.recognizableEventCount += 1;
    const payload = event.payload;
    if (payload.type === 'message') {
      const message = assistantText(payload);
      if (message) state.currentAssistantMessages.push(message);
      return message ? { kind: 'activity', label: 'Assistant response received' } : null;
    }
    if (payload.type === 'function_call' || payload.type === 'function_call_output') {
      state.toolActivitySeen = true;
      return { kind: 'activity', label: 'Workspace tool activity observed' };
    }
    return null;
  }

  const payload = currentPayload(event);
  if (event.type === 'event_msg' || ['task_complete', 'token_count'].includes(String(event.type))) {
    state.recognizableEventCount += 1;
    if (payload.type === 'task_complete') {
      state.taskCompleted = true;
      state.taskCompleteMessage = nonEmpty(payload.last_agent_message);
      return { kind: 'activity', label: 'Runtime task completed' };
    }
    if (payload.type === 'token_count') {
      const info = record(payload.info) ? payload.info : null;
      const next = usage(info?.total_token_usage);
      if (next) {
        state.currentUsage = next;
        return { kind: 'usage', usage: next };
      }
    }
  }
  return null;
}

export function codexProtocolResult(state: CodexProtocolState): {
  output: string | null;
  threadId: string | null;
  usage: RunUsage | null;
} {
  return {
    output:
      state.taskCompleteMessage ??
      state.currentAssistantMessages.at(-1) ??
      state.legacyAssistantMessages.at(-1) ??
      null,
    threadId: state.threadId,
    usage: state.currentUsage ?? state.legacyUsage,
  };
}
