import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, eventMeaning, readSSE } from '../lib/chat.js';

const event = (content, step, extra = {}) => ({ code: '200', output: { choices: [{ message: { content, extra: { step, ...extra } } }] } });
const stream = (text, width = 1) => {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += width) controller.enqueue(bytes.slice(i, i + width));
    controller.close();
  } });
};
test('planning and tool content never become answers; generation and completion do', () => {
  for (const step of ['planning', 'tool_calling', 'tool_result', '']) assert.equal(eventMeaning(event('internal', step)).text, '');
  assert.equal(eventMeaning(event('税务答案', 'generating')).text, '税务答案');
  assert.equal(eventMeaning(event('', 'generating', { step_change: 'generation_end' })).done, true);
  assert.equal(eventMeaning(event('', 'planning', { step_change: 'planning_end' })).done, false);
});
test('SSE handles split Chinese UTF-8, CRLF, comments, multiline data and trailing frames', async () => {
  const input = ':ping\r\nid:1\r\nevent:result\r\ndata: {"code":"200",\r\ndata: "message":"税务"}\r\n\r\ndata: {"code":"200","message":"尾部"}';
  for (const width of [1, 2, 7, 33, 1000]) {
    const output = []; await readSSE(stream(input, width), e => output.push(e));
    assert.deepEqual(output.map(e => e.message), ['税务', '尾部']);
  }
});
test('SSE accepts DONE and propagates malformed frames and API errors', async () => {
  const seen = []; await readSSE(stream('data: {"code":"200"}\n\ndata: [DONE]\n\n'), e => seen.push(e));
  assert.equal(seen.length, 1);
  await assert.rejects(readSSE(stream('data: invalid\n\n'), () => {}), /无法解析/);
  await assert.rejects(readSSE(stream('data: {"code":"InvalidApiKey","message":"bad key"}\n\n'), eventMeaning), /bad key/);
  assert.throws(() => eventMeaning({ error: { message: 'denied' } }), /denied/);
});
test('history includes complete adjacent pairs only, without mutating the source', () => {
  const turns = [
    { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1', status: 'complete' },
    { role: 'user', content: 'u2' }, { role: 'assistant', content: 'partial', status: 'stopped' },
    { role: 'user', content: 'u3' }, { role: 'assistant', content: 'error', status: 'error' },
  ];
  assert.deepEqual(buildMessages(turns, 'u4').map(t => t.content), ['u1', 'a1', 'u4']);
  assert.equal(turns.length, 6);
  assert.deepEqual(buildMessages(turns, 'u4', 3).map(t => t.content), ['u4']);
});
test('history keeps at most ten most recent complete rounds', () => {
  const turns = Array.from({ length: 15 }, (_, i) => [
    { role: 'user', content: `u${i}` }, { role: 'assistant', content: `a${i}`, status: 'complete' },
  ]).flat();
  const result = buildMessages(turns, 'next');
  assert.equal(result.length, 21); assert.equal(result[0].content, 'u5');
});
