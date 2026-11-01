import { describe, expect, test } from 'vitest';
import { CredentialRedactor } from '../src/reviewer/credential-redactor.js';
import { maskAttempt, type ReviewAttempt } from '../src/reviewer/attempt.js';
import { readChatAnswer, readDecisionAnswer } from '../src/reviewer/signals.js';
import { NEW_SCALE_TYPESAFE } from './helpers/decision-captures.js';

const masked: unknown = expect.stringContaining('[redacted:v1:');

describe('credential score roles follow the actual protocol and channel', () => {
  test.each(['error', 'usage', 'recoverability'])(
    'production Chat with extra %s gets no numeric authentication exemption',
    (field) => {
      const answer = { risk: 3, authorization: 8, [field]: 'unknown' };
      const text = JSON.stringify(answer);
      expect(readChatAnswer(text).ok).toBe(false);
      const redactor = new CredentialRedactor(`strict-chat-${field}`, ['8']);
      expect(redactor.value(answer, 'chat')).toMatchObject({
        authorization: masked,
      });
      expect(JSON.parse(redactor.text(text, 'chat'))).toMatchObject({
        authorization: masked,
      });
    },
  );
  test('a decision response cannot borrow a Chat root score shape', () => {
    const answer = { risk: 3, authorization: 8 };
    expect(readChatAnswer(JSON.stringify(answer)).ok).toBe(true);
    expect(readDecisionAnswer(answer).ok).toBe(false);
    expect(
      new CredentialRedactor('wrong-decision-protocol', ['8']).value(
        answer,
        'decision',
      ),
    ).toMatchObject({ authorization: masked });
  });
  test('a valid Chat pair and valid decision answers retain protocol scores', () => {
    const pair = { risk: 3, authorization: 8 };
    expect(readChatAnswer(JSON.stringify(pair)).ok).toBe(true);
    expect(readDecisionAnswer(NEW_SCALE_TYPESAFE).ok).toBe(true);
    expect(
      new CredentialRedactor('valid-chat-protocol', ['8']).value(pair, 'chat'),
    ).toEqual(pair);
    expect(
      new CredentialRedactor('valid-decision-protocol', ['8', 'score']).value(
        NEW_SCALE_TYPESAFE,
        'decision',
      ),
    ).toEqual(NEW_SCALE_TYPESAFE);
  });
  test('a transport error is never a score answer even when its JSON is a valid Chat pair', () => {
    const error = JSON.stringify({ risk: 3, authorization: 8 });
    const attempt: ReviewAttempt = {
      attemptId: 'error-channel:model:1',
      callId: 'error-channel',
      attempt: 1,
      backend: 'chat',
      protocol: 'chat',
      request: {},
      responseText: null,
      parsed: null,
      error,
      failureKind: 'transport',
      startedAt: 0,
      durationMs: 1,
      estimatedInputTokens: 1,
      rawUsage: null,
      normalizedUsage: null,
    };
    const safe = maskAttempt(attempt, ['8']);
    expect(JSON.parse(safe.error ?? '')).toMatchObject({
      authorization: masked,
    });
    expect(attempt.error).toBe(error);
  });
});
