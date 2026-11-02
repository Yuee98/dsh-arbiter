import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withWorkflowArea } from '../evals/helpers/workflow-run.js';
import {
  dualProtocolPlan,
  frozenWorkflowReferences,
} from '../evals/helpers/report-workflow.js';
import { reportRun } from '../../evals/src/report/command.js';
import { readReferenceSnapshot } from '../../evals/src/metrics/reference-snapshot.js';
import { readRun } from '../../evals/src/run/artifact.js';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';
import { fixtureCell, fixtureOf } from '../evals/helpers/run.js';
import { cellGrid } from '../../evals/src/run/grid.js';

it('refuses an output destination containing a credential from private saved configuration', async () => {
  await withWorkflowArea(async (area) => {
    const base = dualProtocolPlan(area.plan);
    if (base.workflow === undefined) throw new Error('missing workflow');
    const secret = 'synthetic_destination_canary_131';
    const plan = {
      ...base,
      workflow: {
        ...base.workflow,
        input: {
          ...base.workflow.input,
          customRules: `Authorization: Bearer ${secret}`,
        },
      },
    };
    await area.write(plan);
    expect(await area.cli(['run', area.planPath])).toBe(0);
    const before = await readFile(
      join(area.runDirectory, 'index.json'),
      'utf8',
    );
    const output = join(area.directory, secret);
    expect(
      await reportRun(
        { root: area.root, out: () => {}, err: () => {} },
        {
          directory: area.runDirectory,
          dataset: null,
          output,
          mode: 'ask',
          channel: 'available',
          force: false,
        },
      ),
    ).toBe(1);
    await expect(readFile(`${output}.json`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(area.runDirectory, 'index.json'), 'utf8')).toBe(
      before,
    );
  });
}, 30_000);

it('keeps large rationales out of compact Markdown while retaining every row and its evidence location', async () => {
  await withWorkflowArea(async (area) => {
    const plan = dualProtocolPlan(area.plan);
    await area.write(plan);
    const refs = await frozenWorkflowReferences(area.directory, plan);
    const rationale = `BEGIN_LARGE_BODY ${'bounded body '.repeat(1000)} END_LARGE_BODY`;
    for (const path of refs) {
      const snapshot = await readReferenceSnapshot(path);
      await writeFile(
        path,
        JSON.stringify({
          ...snapshot,
          entries: snapshot.entries.map((entry) => ({
            ...entry,
            reference:
              entry.reference === null
                ? null
                : {
                    ...entry.reference,
                    target: { ...entry.reference.target, rationale },
                  },
          })),
        }),
      );
    }
    expect(await area.cli(['run', area.planPath])).toBe(0);
    const output = join(area.directory, 'compact');
    expect(
      await reportRun(
        { root: area.root, out: () => {}, err: () => {} },
        {
          directory: area.runDirectory,
          dataset: null,
          references: refs,
          output,
          mode: 'ask',
          channel: 'available',
          force: false,
        },
      ),
    ).toBe(0);
    const markdown = await readFile(`${output}.md`, 'utf8');
    expect(markdown).toContain('BEGIN_LARGE_BODY');
    expect(markdown).not.toContain('END_LARGE_BODY');
    expect(markdown).toContain('正文见原工件');
    const report: unknown = JSON.parse(
      await readFile(`${output}.json`, 'utf8'),
    );
    expect(report).toHaveProperty('examples.length', 8);
    expect(await readFile(`${output}.json`, 'utf8')).toContain(
      'END_LARGE_BODY',
    );
    for (const file of await readdir(`${output}.details`)) {
      const text = await readFile(join(`${output}.details`, file), 'utf8');
      expect(text).not.toContain('END_LARGE_BODY');
      expect(text).toContain('/records/');
    }
  });
}, 30_000);

it('redacts saved technical failure details and leaves the raw records unchanged', async () => {
  await withWorkflowArea(async (area) => {
    await area.write();
    await writeFile(
      area.fixturePath,
      JSON.stringify(
        fixtureOf(
          Object.fromEntries(
            cellGrid(area.plan).cells.map((cell) => [
              cell.cellId,
              fixtureCell({
                decision: [
                  { status: 503, body: '{"error":"synthetic refusal"}' },
                ],
              }),
            ]),
          ),
        ),
      ),
    );
    expect(await area.cli(['run', area.planPath])).toBe(0);
    const checkers = await compileRunCheckers();
    const actual = await readRun(area.runDirectory, checkers, {
      allowWorkflow: true,
    });
    if (!actual.ok) throw new Error('missing run');
    const record = actual.artifact.records[0];
    if (
      record?.outcome === null ||
      record === undefined ||
      record.outcome.status !== 'review-failure'
    )
      throw new Error('missing failure');
    const secret = 'synthetic_failure_canary_131';
    const updated = {
      ...record,
      outcome: { ...record.outcome, reason: `Authorization: Bearer ${secret}` },
    };
    expect(checkers.record(updated).ok).toBe(true);
    const path = join(area.runDirectory, 'records', `${record.cellId}.json`);
    const raw = JSON.stringify(updated);
    await writeFile(path, raw);
    const output = join(area.directory, 'failure');
    expect(
      await reportRun(
        { root: area.root, out: () => {}, err: () => {} },
        {
          directory: area.runDirectory,
          dataset: null,
          output,
          mode: 'ask',
          channel: 'available',
          force: false,
        },
      ),
    ).toBe(0);
    const paths = ['json', 'md', 'html'].map(
      (extension) => `${output}.${extension}`,
    );
    paths.push(
      ...(await readdir(`${output}.details`)).map((file) =>
        join(`${output}.details`, file),
      ),
    );
    for (const file of paths)
      expect(await readFile(file, 'utf8')).not.toContain(secret);
    expect(await readFile(path, 'utf8')).toBe(raw);
    const report: unknown = JSON.parse(
      await readFile(`${output}.json`, 'utf8'),
    );
    expect(report).toHaveProperty('quality.overall.conditions.technical', 2);
  });
}, 30_000);

describe(
  'one public projection for all report artifacts',
  { timeout: 30_000 },
  () => {
    it('redacts actual reference text across JSON/MD/HTML/group details and retains original evidence', async () => {
      await withWorkflowArea(async (area) => {
        const plan = dualProtocolPlan(area.plan);
        await area.write(plan);
        const refs = await frozenWorkflowReferences(area.directory, plan);
        const secret = 'synthetic_reference_canary_131';
        const originals: string[] = [];
        for (const path of refs) {
          const snapshot = await readReferenceSnapshot(path);
          const entries = snapshot.entries.map((entry) => ({
            ...entry,
            reference:
              entry.reference === null
                ? null
                : {
                    ...entry.reference,
                    target: {
                      ...entry.reference.target,
                      rationale: `Authorization: Bearer ${secret}\n![bad](https://example.invalid/x)`,
                    },
                  },
          }));
          const text = JSON.stringify({ ...snapshot, entries });
          await writeFile(path, text);
          originals.push(text);
        }
        expect(await area.cli(['run', area.planPath])).toBe(0);
        const output = join(area.directory, 'public');
        const options = {
          directory: area.runDirectory,
          dataset: null,
          output,
          references: refs,
          mode: 'ask',
          channel: 'available',
          force: true,
        };
        const io = { root: area.root, out: () => {}, err: () => {} };
        expect(await reportRun(io, options)).toBe(0);
        const paths = ['json', 'md', 'html'].map(
          (extension) => `${output}.${extension}`,
        );
        paths.push(
          ...(await readdir(`${output}.details`)).map((file) =>
            join(`${output}.details`, file),
          ),
        );
        const texts = await Promise.all(
          paths.map((path) => readFile(path, 'utf8')),
        );
        for (const text of texts) expect(text).not.toContain(secret);
        const json: unknown = JSON.parse(texts[0] ?? 'null');
        expect(json).toMatchObject({
          quality: { overall: { conditions: { compared: 4 } } },
        });
        for (const [index, path] of refs.entries())
          expect(await readFile(path, 'utf8')).toBe(originals[index]);
        expect(await reportRun(io, options)).toBe(0);
        expect(
          await Promise.all(paths.map((path) => readFile(path, 'utf8'))),
        ).toEqual(texts);
      });
    });
  },
);
