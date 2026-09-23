// A provider's refusal, read out of its body rather than pasted in as JSON.
import { expect, test } from 'bun:test';
import { llmErrorMessage, readLlmBody } from '../llm-error.ts';
import { isImageRefusal } from '../images.ts';

test('an OpenAI-style error is read for its message and request id', () => {
  expect(readLlmBody('{"error":{"message":"The model `x` does not exist","type":"invalid_request_error","code":"model_not_found","request_id":"req_abcdef123456"}}'))
    .toEqual({ message: 'The model `x` does not exist', requestId: 'req_abcdef123456' });
  // A code or a type alone still says something.
  expect(readLlmBody('{"error":{"code":"rate_limited"}}').message).toBe('rate_limited');
  expect(readLlmBody('{"error":"quota exceeded"}').message).toBe('quota exceeded');
});

test('a flat message, and a detail as text or as a list, are read too', () => {
  expect(readLlmBody('{ "message":"model_access_denied", "request_id":"2395f0a1-77" }')).toEqual({ message: 'model_access_denied', requestId: '2395f0a1-77' });
  expect(readLlmBody('{"detail":"Not authenticated"}').message).toBe('Not authenticated');
  expect(readLlmBody('{"detail":[{"msg":"field required"},{"msg":"value is not a list"}]}').message).toBe('field required; value is not a list');
});

test('a body that is not JSON is its own text, collapsed and cut', () => {
  expect(readLlmBody('upstream   is\n down').message).toBe('upstream is down');
  const long = readLlmBody(`<html>${'x'.repeat(1000)}</html>`).message;
  expect(long.length).toBeLessThanOrEqual(200);
  expect(long.endsWith('…')).toBe(true);
  expect(readLlmBody('')).toEqual({ message: '', requestId: '' });
});

test('the line: status, model, the message, a short request id, and a hint for a refusal of access', () => {
  expect(llmErrorMessage(403, '{ "message":"model_access_denied", "request_id":"2395f0a1-77aa" }', { model: 'big-model' }))
    .toBe('LLM 403 · big-model: model_access_denied (request 2395f0a1) — the token or the model is not allowed; config set ai.model <model> or check the token');
  expect(llmErrorMessage(500, 'upstream is down')).toBe('LLM 500: upstream is down');
  // An empty body says what the status line said, or that there was nothing.
  expect(llmErrorMessage(502, '', { statusText: 'Bad Gateway' })).toBe('LLM 502: Bad Gateway');
  expect(llmErrorMessage(502, '')).toBe('LLM 502: no response body');
  // The request id from the response header, when the body has none.
  expect(llmErrorMessage(429, '{"error":{"message":"slow down"}}', { requestId: 'abcdef0123456789' })).toBe('LLM 429: slow down (request abcdef01)');
});

test('an image refusal read this way is still told apart', () => {
  expect(isImageRefusal(llmErrorMessage(400, '{"error":{"message":"image_url is not supported by this model"}}', { model: 'm' }))).toBe(true);
  expect(isImageRefusal(llmErrorMessage(400, '{"error":{"message":"context length exceeded"}}', { model: 'm' }))).toBe(false);
});
