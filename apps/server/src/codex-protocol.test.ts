import { describe, expect, it } from 'vitest';
import {
  codexProtocolResult,
  consumeCodexProtocolLine,
  createCodexProtocolState,
} from './codex-protocol.js';

const consume = (events: unknown[]) => {
  const state = createCodexProtocolState();
  for (const event of events) consumeCodexProtocolLine(JSON.stringify(event), state);
  return { state, result: codexProtocolResult(state) };
};

describe('Codex protocol normalization', () => {
  it('supports legacy message, thread, and usage events', () => {
    const { state, result } = consume([
      { type: 'thread.started', thread_id: 'thread-legacy' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Legacy done.' } },
      { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 } },
    ]);
    expect(result).toEqual({ output: 'Legacy done.', threadId: 'thread-legacy', usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3 } });
    expect(state.taskCompleted).toBe(true);
  });

  it('supports the current response protocol and task-complete precedence', () => {
    const { result } = consume([
      { type: 'session_meta', id: 'thread-current' },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Assistant response.' }] } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 20, cached_input_tokens: 8, output_tokens: 5 } } } },
      { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Final report.' } },
    ]);
    expect(result).toEqual({ output: 'Final report.', threadId: 'thread-current', usage: { inputTokens: 20, cachedInputTokens: 8, outputTokens: 5 } });
  });

  it('accepts the sanitized Ark no-prose shape without exposing reasoning', () => {
    const secretReasoning = 'private chain of thought';
    const { state, result } = consume([
      { type: 'session_meta', id: 'thread-ark' },
      { type: 'response_item', payload: { type: 'function_call', name: 'shell_command', arguments: '{sanitized}' } },
      { type: 'event_msg', payload: { type: 'agent_reasoning', text: secretReasoning } },
      { type: 'response_item', payload: { type: 'reasoning', summary: [{ text: secretReasoning }], encrypted_content: 'opaque' } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 140, cached_input_tokens: 80, output_tokens: 12 } } } },
      { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: null } },
    ]);
    expect(result).toEqual({ output: null, threadId: 'thread-ark', usage: { inputTokens: 140, cachedInputTokens: 80, outputTokens: 12 } });
    expect(state).not.toEqual(expect.objectContaining({ assistantMessages: expect.arrayContaining([secretReasoning]) }));
    expect(JSON.stringify(result)).not.toContain(secretReasoning);
    expect(state.toolActivitySeen).toBe(true);
    expect(state.taskCompleted).toBe(true);
  });

  it('uses the latest cumulative token count and does not add legacy usage', () => {
    const { result } = consume([
      { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 8, output_tokens: 4 } } } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 13, output_tokens: 7 } } } },
    ]);
    expect(result.usage).toEqual({ inputTokens: 13, outputTokens: 7 });
  });

  it('leaves empty and unrelated output unrecognizable', () => {
    const state = createCodexProtocolState();
    consumeCodexProtocolLine('not json', state);
    consumeCodexProtocolLine(JSON.stringify({ type: 'unrelated', text: 'not assistant output' }), state);
    expect(state.recognizableEventCount).toBe(0);
    expect(codexProtocolResult(state).output).toBeNull();
  });
});
