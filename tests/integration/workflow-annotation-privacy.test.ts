import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { responseOpinion } from '../../evals/src/annotation/workflow-opinion.js';
import {
  importWorkflowOpinions,
  workflowReferences,
} from '../../evals/src/annotation/workflow-service.js';
import {
  workflowRecords,
  workflowState,
} from '../../evals/src/annotation/workflow-store.js';
import type { ReturnedResponse } from '../../evals/src/annotation/workflow-types.js';
import {
  answer,
  returns,
  withWorkflowAnnotation,
} from '../evals/helpers/workflow-annotation.js';
import { REPOSITORY_ROOT } from '../evals/helpers/dataset.js';

type Channel = 'metadata' | 'rawResponse' | 'error';
function password(
  response: ReturnedResponse,
  channel: Channel,
  value: string,
): ReturnedResponse {
  if (channel === 'metadata')
    return {
      ...response,
      metadata: { password: value },
    };
  if (channel === 'error') return { ...response, error: `password=${value}` };
  return {
    ...response,
    rawResponse: JSON.stringify(
      answer({ rationale: `Synthetic password=${value}` }),
    ),
  };
}

describe('annotation retry identity cannot disclose low-entropy credentials', () => {
  test.each(['metadata', 'rawResponse', 'error'] as const)(
    '%s retry identity requires private key material that stays out of public artifacts',
    async (channel) => {
      await withWorkflowAnnotation(async (f) => {
        expect((await stat(f.baseline)).mode & 0o777).toBe(0o600);
        const base = returns(f.batch);
        const returned = {
          ...base,
          responses: base.responses.map((value) =>
            password(value, channel, '0421'),
          ),
        };
        await importWorkflowOpinions({ ...f, returned, write: true });
        const first = base.responses[0];
        if (first === undefined) throw new Error('fixture response');
        const record = workflowRecords(
          await workflowState(f.dataset, 'dev', 'f01'),
        ).opinions.find((value) => value.opinion.reviewId === first.responseId);
        const point = f.batch.points.find(
          (value) => value.questionId === first.questionId,
        );
        const model = f.batch.models.find(
          (value) => value.modelKey === first.modelKey,
        );
        if (point === undefined || model === undefined)
          throw new Error('fixture identity');
        const other = responseOpinion(
          { ...f.batch, retryKey: randomBytes(32).toString('hex') },
          point,
          model,
          password(first, channel, '0421'),
        );
        expect(
          other.annotation?.responseHash === record?.annotation?.responseHash,
        ).toBe(false);
        expect(record?.annotation?.responseHash).toMatch(
          /^hmac-sha256:[a-f0-9]{64}$/u,
        );
        const key = 'retryKey' in f.batch ? f.batch.retryKey : null;
        if (typeof key !== 'string')
          throw new Error('missing private retry key');
        const publicText = await readFile(
          join(f.dataset, 'dev/f01/opinions.json'),
          'utf8',
        );
        expect(publicText.includes(key)).toBe(false);
        expect(
          (
            await readFile(join(f.dataset, 'dev/f01/labels.json'), 'utf8')
          ).includes(key),
        ).toBe(false);
        expect(
          JSON.stringify(
            await workflowReferences({
              dataset: f.dataset,
              split: 'dev',
              group: 'f01',
              context: f.batch.context,
            }),
          ).includes(key),
        ).toBe(false);
        expect(publicText).not.toContain('password=0421');
        expect(publicText).not.toContain('"password": "0421"');
        expect((await stat(f.baseline)).mode & 0o777).toBe(0o600);
        for (const name of await readdir(f.out)) {
          expect(
            (await readFile(join(f.out, name), 'utf8')).includes(key),
          ).toBe(false);
        }
      });
    },
    30_000,
  );

  test('cross-process same-ID retries keep secret-only and nonsecret conflicts distinct', async () => {
    await withWorkflowAnnotation(async (f) => {
      const base = returns(f.batch);
      const returned = {
        ...base,
        responses: base.responses.map((value) =>
          password(value, 'metadata', '0421'),
        ),
      };
      const path = join(f.root, 'answers.json');
      await writeFile(path, JSON.stringify(returned));
      const run = promisify(execFile),
        cli = join(REPOSITORY_ROOT, 'evals/src/cli.ts');
      const args = [
        cli,
        'workflow-import',
        f.dataset,
        '--batch',
        f.baseline,
        '--answers',
        path,
        '--write',
      ];
      await run(process.execPath, args, { cwd: REPOSITORY_ROOT });
      const file = join(f.dataset, 'dev/f01/opinions.json');
      const before = await readFile(file, 'utf8');
      await run(process.execPath, args, { cwd: REPOSITORY_ROOT });
      expect(await readFile(file, 'utf8')).toBe(before);
      for (const responses of [
        base.responses.map((value) => password(value, 'metadata', '0422')),
        returned.responses.map((value) => ({
          ...value,
          metadata: { password: '0421', note: 'different nonsecret content' },
        })),
      ]) {
        await writeFile(path, JSON.stringify({ ...returned, responses }));
        await expect(
          run(process.execPath, args, { cwd: REPOSITORY_ROOT }),
        ).rejects.toThrow(/immutable/u);
        expect(await readFile(file, 'utf8')).toBe(before);
      }
      expect((await stat(f.baseline)).mode & 0o777).toBe(0o600);
    });
  }, 30_000);

  test('a readable old batch without its private retry key fails model import conservatively', async () => {
    await withWorkflowAnnotation(async (f) => {
      const before = await readFile(
        join(f.dataset, 'dev/f01/opinions.json'),
        'utf8',
      );
      await writeFile(
        f.baseline,
        JSON.stringify(
          Object.fromEntries(
            Object.entries(f.batch).filter(([key]) => key !== 'retryKey'),
          ),
        ),
      );
      await expect(
        importWorkflowOpinions({
          ...f,
          returned: returns(f.batch),
          write: true,
        }),
      ).rejects.toThrow(/private retry key.*re-export/u);
      expect(
        await readFile(join(f.dataset, 'dev/f01/opinions.json'), 'utf8'),
      ).toBe(before);
    });
  }, 30_000);
});
