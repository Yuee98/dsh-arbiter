import { describe, expect, test } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { caseMaterial } from '../../evals/src/run/material.js';
import type { ReviewCase } from '../../evals/src/data/types.js';
import { digestOf } from '../../evals/src/data/hash.js';
import { reviewWith } from '../../src/reviewer/service.js';
import { PRODUCTION_PACKAGE } from '../../src/reviewer/package.js';
import { estimateChatInput } from '../../src/reviewer/prompt.js';
import { snapshotRedactor } from '../../src/snapshot/redaction.js';
import type { ChatRequest } from '../../src/reviewer/prompt.js';
import type { LlmLike } from '../../src/reviewer/llm.js';
import { coreCases } from './helpers/report-run.js';

const dataset = await coreCases();
const found = dataset.cases.find(
  (entry) => entry.caseId === 'read-named-source-file',
);
if (found === undefined) throw new Error('missing committed case');
const sample = found;

test.each(['context', 'rules', 'action'] as const)(
  'discovers complete legacy credentials before %s clipping and fingerprints the actual send',
  async (location) => {
    const tail = `TAIL_${location.toUpperCase()}_SENSITIVE_VALUE`;
    const secret = 'opaque value '.repeat(2500) + tail;
    const payload = { padding: 'padding '.repeat(5000), apiKey: secret };
    const entry: ReviewCase = {
      ...sample,
      caseId: `${sample.caseId}-privacy-${location}`,
      input: {
        ...sample.input,
        context:
          location === 'context'
            ? [{ tool: 'bash', arguments: JSON.stringify(payload) }]
            : [],
        action:
          location === 'action'
            ? { name: 'run_code', arguments: { code: 'echo ok', ...payload } }
            : sample.input.action,
        policy: {
          ...sample.input.policy,
          customRules: location === 'rules' ? JSON.stringify(payload) : '',
        },
      },
    };
    const originalInput = structuredClone(entry.input);
    const material = caseMaterial(entry, 'chat', {
      targetInputTokens: 6000,
      maxInputTokens: 10000,
    });
    const wire: ChatRequest[] = [];
    const llm: LlmLike = {
      stream: (options) => {
        const message = options.messages[0];
        if (message === undefined) throw new Error('missing actual message');
        wire.push({
          system: options.system,
          user: message.content.map((part) => part.text).join(''),
          estimatedInputTokens: estimateChatInput(
            options.system,
            options.messages,
          ),
        });
        return (async function* () {
          await Promise.resolve();
          yield { type: 'text-delta', text: '{"risk":2,"authorization":10}' };
          yield {
            type: 'usage',
            usage: { input_tokens: 20, output_tokens: 3 },
          };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    };
    const result = await reviewWith(PRODUCTION_PACKAGE)({
      snapshot: material.snapshot,
      callId: entry.caseId,
      signal: new AbortController().signal,
      backend: {
        kind: 'chat',
        transport: {
          llm,
          chat: {
            ...DEFAULT_CONFIG.reviewer.chat,
            provider: 'fixture',
            model: 'fixture',
          },
          signal: new AbortController().signal,
        },
      },
    });
    expect(wire).toHaveLength(1);
    expect(material.snapshot.context).toHaveLength(
      location === 'context' ? 1 : 0,
    );
    expect(material.snapshot.context[0]?.argumentsTruncated ?? false).toBe(
      location === 'context',
    );
    expect(result.outcome.status).toBe('scored');
    expect(JSON.stringify(wire)).not.toContain(tail);
    expect(JSON.stringify(material.request)).not.toContain(tail);
    expect(JSON.stringify(result)).not.toContain(tail);
    expect(material.material.promptFingerprint).toBe(
      digestOf({ protocol: 'chat', request: wire[0] }),
    );
    expect(wire[0]?.estimatedInputTokens).toBeLessThanOrEqual(10000);
    expect(material.snapshot.budget.estimatedInputTokens).toBeLessThanOrEqual(
      10000,
    );
    expect(snapshotRedactor(material.snapshot)).toBeDefined();
    expect(entry.input).toEqual(originalInput);
  },
);

describe('legacy ordinary roles preserve original human priority', () => {
  test.each([
    {
      label: 'tool fact',
      origin: '本会话人类原文',
      kind: 'material-quote',
      note: '工具结果原文',
    },
    {
      label: 'local link',
      origin: '本会话人类原文',
      kind: 'link',
      note: '本会话人类来源引用',
    },
    {
      label: 'parent link',
      origin: '直接父会话人类原文',
      kind: 'link',
      note: '直接父会话来源引用',
    },
  ] as const)(
    'a newer $label cannot evict an older original human restriction',
    ({ origin, kind, note }) => {
      const older = {
        kind: 'material-quote' as const,
        ref: 'OLDER_HUMAN_RESTRICTION ' + 'alpha beta '.repeat(1000),
        note: origin,
      };
      const latest = {
        kind: 'material-quote' as const,
        ref: 'LATEST_HUMAN create the report',
        note: origin,
      };
      const reference: ReviewCase = {
        ...sample,
        input: { ...sample.input, evidence: [latest] },
      };
      const required = caseMaterial(reference, 'chat', {
        targetInputTokens: 1,
        maxInputTokens: 20000,
      });
      const target = required.snapshot.budget.estimatedInputTokens + 2300;
      const entry: ReviewCase = {
        ...reference,
        input: {
          ...reference.input,
          evidence: [
            older,
            { kind, ref: 'REFERENCE_FACT ' + 'data fact '.repeat(1000), note },
            latest,
          ],
        },
      };
      const material = caseMaterial(entry, 'chat', {
        targetInputTokens: target,
        maxInputTokens: target,
      });
      expect(
        material.snapshot.evidence
          .filter((item) => item.evidence === 'explicit')
          .map((item) => item.text),
      ).toEqual([older.ref, latest.ref]);
      expect(material.snapshot.budget.estimatedInputTokens).toBeLessThanOrEqual(
        target,
      );
    },
  );

  test('omitted references have their own nonblocking description without inventing lost human originals or action facts', () => {
    const entry: ReviewCase = {
      ...sample,
      input: {
        ...sample.input,
        action: { name: 'unknown-tool', arguments: {} },
        evidence: [
          {
            kind: 'material-quote',
            ref: 'ACTUAL_HUMAN_ORIGINAL',
            note: '本会话人类原文',
          },
          {
            kind: 'material-quote',
            ref: 'RAW_TOOL_REFERENCE',
            note: '工具结果原文',
          },
        ],
      },
    };
    const material = caseMaterial(entry, 'chat', {
      targetInputTokens: 1,
      maxInputTokens: 10000,
    });
    expect(material.snapshot.evidence.map((item) => item.text)).toEqual([
      'ACTUAL_HUMAN_ORIGINAL',
    ]);
    expect(material.snapshot.evidenceTruncated).toBe(true);
    expect(material.snapshot.missing.join(' ')).toContain(
      'Non-authorizing evidence references were omitted',
    );
    expect(material.snapshot.missing.join(' ')).not.toContain(
      'older human messages were not submitted',
    );
    expect(material.snapshot.budget.truncatedSegments).not.toContain(
      'DERIVED_FACTS',
    );
    expect(material.snapshot.completeness.gaps).toEqual([]);
    expect(JSON.stringify(material.request)).toContain(
      'the program could not be parsed',
    );
  });
});
