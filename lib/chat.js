export const DEFAULT_AGENT = 'aid-c13de479d8944f12b3c45ef9a45af154';
export const ENDPOINT = 'https://llm-zc86z2f8ixro6odd.cn-beijing.maas.aliyuncs.com/api/v2/apps/knowledge/chat';

// Only complete user/assistant pairs enter context. Failed or stopped turns are excluded.
export function buildMessages(turns, question, budget = 24000) {
  const pairs = [];
  let used = question.length;
  for (let i = turns.length - 1; i >= 1; i--) {
    const answer = turns[i];
    const user = turns[i - 1];
    if (answer.role !== 'assistant' || answer.status !== 'complete' || user.role !== 'user') continue;
    const size = user.content.length + answer.content.length;
    if (used + size > budget || pairs.length >= 10) break;
    pairs.unshift([{ role: 'user', content: user.content }, { role: 'assistant', content: answer.content }]);
    used += size;
    i--;
  }
  return [...pairs.flat(), { role: 'user', content: question }];
}

export function eventMeaning(event) {
  if (event.error) throw new Error(event.error.message || '百炼接口返回错误。');
  if (event.code !== undefined && !['200', 'Success', 'SUCCESS', 'success'].includes(String(event.code))) {
    throw new Error(`${event.message || '百炼请求失败'}（${event.code}）`);
  }
  const choice = event.output?.choices?.[0] || event.choices?.[0];
  const message = choice?.message || choice?.delta;
  if (!message) return { usage: event.usage };
  const step = message.extra?.step || '';
  const change = message.extra?.step_change || '';
  const finalPhase = step === 'generating' || change.startsWith('generation_');
  const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
    ? message.content.filter(p => p.type === 'text').map(p => p.text || '').join('') : '';
  return {
    text: finalPhase ? text : '',
    phase: finalPhase ? '正在生成回答' : step.startsWith('tool') ? '正在检索知识库' : '正在整理相关资料',
    done: finalPhase && (change === 'generation_end' || choice.finish_reason === 'stop'),
    usage: event.usage,
    requestId: event.request_id,
  };
}

// Incremental SSE parser: supports split UTF-8, CRLF, multiline data and trailing events.
export async function readSSE(stream, onEvent) {
  if (!stream) throw new Error('浏览器未收到响应流。');
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '', data = [];
  let ended = false;
  const emit = () => {
    if (!data.length) return;
    const payload = data.join('\n');
    data = [];
    if (payload.trim() === '[DONE]') { ended = true; return; }
    let event;
    try { event = JSON.parse(payload); } catch { throw new Error('收到无法解析的响应，请重试。'); }
    onEvent(event);
  };
  const line = value => {
    if (!value) emit();
    else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  };
  try {
    while (!ended) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, at).replace(/\r$/, ''));
        buffer = buffer.slice(at + 1);
      }
      if (buffer.length > 2_000_000) throw new Error('单段响应过大，请缩短问题后重试。');
      if (done) { if (buffer) line(buffer.replace(/\r$/, '')); emit(); break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
