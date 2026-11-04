import { readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as metrics from '../../evals/src/metrics/index.js';
import { withWorkflowArea } from '../evals/helpers/workflow-run.js';
import { replayReferences } from '../evals/helpers/replay-workflow.js';
import { cellGrid } from '../../evals/src/run/plan.js';
import {
  chatAnswer,
  decisionAnswer,
  dualTarget,
  fixtureCell,
  fixtureOf,
} from '../evals/helpers/run.js';
import {
  parseReplayCommand,
  replayRun,
} from '../../evals/src/replay/command.js';
import {
  parseVariants,
  REPLAY_VARIANTS_VERSION,
} from '../../evals/src/replay/index.js';
import {
  defaultSettings,
  reportForRun,
} from '../../evals/src/metrics/index.js';
import { inventory } from '../evals/helpers/replay.js';
import { readRun, recordPathOf } from '../../evals/src/run/artifact.js';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';
import { readSource } from '../../evals/src/replay/source.js';
import {
  defaultPrefixOf,
  reportPathsOf,
} from '../../evals/src/report/write.js';

const checkers = await compileRunCheckers();
afterEach(() => vi.restoreAllMocks());

const matrix = {
  id: 'require-nine',
  requiredAuthorization: [2, 2, 9, 9, 9, 9, 10, 10, 10, 10],
};

describe('workflow matrix replay keeps independent frozen references', () => {
  it('generates an unlabelled report without inventing a quality pass', async () => {
    await withWorkflowArea(async (area) => {
      await area.write();
      expect(await area.cli(['run', area.planPath])).toBe(0);
      const document = {
        variantsVersion: REPLAY_VARIANTS_VERSION,
        variants: [{ matrix }],
      };
      const parsed = parseVariants(document);
      if (!parsed.ok || parsed.variants[0] === undefined)
        throw new Error('variant missing');
      const file = join(area.directory, 'variants.json'),
        output = join(area.directory, 'derived');
      await writeFile(file, JSON.stringify(document));
      expect(
        await area.cli([
          'replay',
          area.runDirectory,
          '--variants',
          file,
          '--out',
          output,
        ]),
      ).toBe(0);
      const report = await reportForRun({
        directory: join(output, parsed.variants[0].variantId),
        settings: defaultSettings(area.root),
      });
      if (!report.ok) throw new Error(report.problems.join('; '));
      expect(report.report.quality?.references.cellsBySource).toEqual({
        unresolved: 2,
      });
      expect(report.report.examples).toHaveLength(2);
      expect(
        report.report.examples.every((cell) => cell.reference === null),
      ).toBe(true);
      expect(
        report.report.quality?.overall.conditional.falseAllow.denominator,
      ).toBe(0);
    });
  });
  it.each(['directory', 'symlink'])(
    'protects original references from --force through a %s',
    async (kind) => {
      await withWorkflowArea(async (area) => {
        if (area.plan.workflow === undefined)
          throw new Error('workflow missing');
        const plan = {
          ...area.plan,
          workflow: {
            ...area.plan.workflow,
            input: {
              customRules: '',
              projectRules: {
                kind: 'provided' as const,
                text: 'Synthetic guidance.',
              },
            },
          },
        };
        await area.write(plan);
        expect(await area.cli(['run', area.planPath])).toBe(0);
        const refs = await replayReferences(area.root, area.directory, plan);
        const doc = {
          variantsVersion: REPLAY_VARIANTS_VERSION,
          variants: [{ matrix }],
        };
        const parsed = parseVariants(doc);
        if (
          !parsed.ok ||
          parsed.variants[0] === undefined ||
          refs[0] === undefined
        )
          throw new Error('fixture missing');
        const file = join(area.directory, 'variants.json'),
          output = join(area.directory, 'derived');
        await writeFile(file, JSON.stringify(doc));
        await mkdir(output);
        const target = join(output, parsed.variants[0].variantId);
        const real =
          kind === 'symlink'
            ? join(area.directory, 'reference-evidence')
            : target;
        await mkdir(real);
        if (kind === 'symlink') await symlink(real, target, 'dir');
        const input = join(real, 'input.json');
        const bytes = await readFile(refs[0]);
        await writeFile(input, bytes);
        expect(
          await area.cli([
            'replay',
            area.runDirectory,
            '--variants',
            file,
            '--out',
            output,
            '--force',
            '--references',
            input,
          ]),
        ).toBe(1);
        expect(await readFile(input)).toEqual(bytes);
        expect(area.log.join('\n')).toContain(
          'resolves to a directory that contains',
        );
      });
    },
  );

  it('refuses to publish if a staged reference copy changes during report generation', async () => {
    await withWorkflowArea(async (area) => {
      if (area.plan.workflow === undefined) throw new Error('workflow missing');
      const plan = {
        ...area.plan,
        workflow: {
          ...area.plan.workflow,
          input: {
            customRules: '',
            projectRules: {
              kind: 'provided' as const,
              text: 'Synthetic guidance.',
            },
          },
        },
      };
      await area.write(plan);
      expect(await area.cli(['run', area.planPath])).toBe(0);
      const refs = await replayReferences(area.root, area.directory, plan);
      const file = join(area.directory, 'variants.json'),
        output = join(area.directory, 'derived');
      await writeFile(
        file,
        JSON.stringify({
          variantsVersion: REPLAY_VARIANTS_VERSION,
          variants: [{ matrix }],
        }),
      );
      const actual = metrics.reportForRun;
      vi.spyOn(metrics, 'reportForRun').mockImplementation(async (options) => {
        const report = await actual(options);
        const copy = options.settings.references?.[0];
        if (copy === undefined) throw new Error('copy missing');
        await writeFile(
          copy,
          (await readFile(copy, 'utf8')).replaceAll(
            '"behaviourReference":"deny"',
            '"behaviourReference":"allow"',
          ),
        );
        return report;
      });
      expect(
        await area.cli([
          'replay',
          area.runDirectory,
          '--variants',
          file,
          '--out',
          output,
          ...refs.flatMap((path) => ['--references', path]),
        ]),
      ).toBe(1);
      expect(area.log.join('\n')).toContain(
        'reference copies changed during report generation',
      );
      expect(await inventory(output)).toEqual([]);
      expect(await readFile(refs[0] ?? '', 'utf8')).toContain(
        '"behaviourReference":"deny"',
      );
    });
  });
  it.each([
    'missing-lineage',
    'source-version',
    'derived-version',
    'derived-attempt',
    'derived-material',
    'derived-outcome',
    'copied-reference',
    'copied-fixture',
    'lineage-variant',
  ])('refuses reference qualification for %s', async (damage) => {
    await withWorkflowArea(async (area) => {
      if (area.plan.workflow === undefined) throw new Error('workflow missing');
      const plan = {
        ...area.plan,
        workflow: {
          ...area.plan.workflow,
          input: {
            customRules: '',
            projectRules: {
              kind: 'provided' as const,
              text: 'Synthetic guidance.',
            },
          },
        },
      };
      await area.write(plan);
      expect(await area.cli(['run', area.planPath])).toBe(0);
      const refs = await replayReferences(area.root, area.directory, plan);
      const file = join(area.directory, 'variants.json'),
        output = join(area.directory, 'derived');
      const document = {
        variantsVersion: REPLAY_VARIANTS_VERSION,
        variants: [{ matrix }],
      };
      await writeFile(file, JSON.stringify(document));
      const parsed = parseVariants(document);
      if (!parsed.ok || parsed.variants[0] === undefined)
        throw new Error('variant missing');
      const variant = parsed.variants[0];
      expect(
        await area.cli([
          'replay',
          area.runDirectory,
          '--variants',
          file,
          '--out',
          output,
          ...refs.flatMap((path) => ['--references', path]),
        ]),
      ).toBe(0);
      const directory = join(output, variant.variantId);
      const copies = refs.map((_, index) =>
        join(directory, 'references', `reference-${String(index + 1)}.json`),
      );
      const settings = { ...defaultSettings(area.root), references: copies };
      const before = await reportForRun({ directory, settings });
      if (!before.ok) throw new Error(before.problems.join('; '));
      expect(before.report.quality?.references.cellsBySource).toEqual({
        human: 2,
      });
      const source = await readRun(area.runDirectory, checkers, {
        allowWorkflow: true,
      });
      const read = await readRun(directory, checkers, { allowWorkflow: true });
      if (!source.ok || !read.ok) throw new Error('run missing');
      const record = read.artifact.records[0];
      if (
        record === undefined ||
        record.material === null ||
        record.outcome?.status !== 'scored'
      )
        throw new Error('record missing');
      if (damage === 'missing-lineage')
        await rm(join(directory, 'lineage.json'));
      if (damage === 'source-version') {
        await writeFile(
          join(area.runDirectory, 'index.json'),
          JSON.stringify({
            ...source.artifact.index,
            versions: {
              ...source.artifact.index.versions,
              implementation: 'unknown-runner',
            },
          }),
        );
        const fresh = await readSource({
          directory: area.runDirectory,
          root: area.root,
        });
        if (!fresh.ok) throw new Error(fresh.problems.join('; '));
        const path = join(directory, 'lineage.json');
        const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (raw === null || typeof raw !== 'object')
          throw new Error('lineage missing');
        await writeFile(
          path,
          JSON.stringify({
            ...Object.fromEntries(Object.entries(raw)),
            source: fresh.source,
          }),
        );
      }
      if (damage === 'derived-version')
        await writeFile(
          join(directory, 'index.json'),
          JSON.stringify({
            ...read.artifact.index,
            versions: {
              ...read.artifact.index.versions,
              implementation: 'unknown-tool',
            },
          }),
        );
      if (damage === 'derived-attempt')
        await writeFile(
          join(directory, recordPathOf(record.cellId)),
          JSON.stringify({
            ...record,
            attempts: record.attempts.map((attempt, index) =>
              index === 0
                ? { ...attempt, responseText: 'different saved answer' }
                : attempt,
            ),
          }),
        );
      if (damage === 'derived-material')
        await writeFile(
          join(directory, recordPathOf(record.cellId)),
          JSON.stringify({
            ...record,
            material: {
              ...record.material,
              estimatedInputTokens: record.material.estimatedInputTokens + 1,
            },
          }),
        );
      if (damage === 'derived-outcome')
        await writeFile(
          join(directory, recordPathOf(record.cellId)),
          JSON.stringify({
            ...record,
            outcome: { ...record.outcome, risk: 10 },
          }),
        );
      if (damage === 'copied-reference') {
        const copy = copies[0];
        if (copy === undefined) throw new Error('copy missing');
        await writeFile(
          copy,
          (await readFile(copy, 'utf8')).replaceAll(
            '"behaviourReference":"deny"',
            '"behaviourReference":"allow"',
          ),
        );
      }
      if (damage === 'copied-fixture')
        await writeFile(join(directory, 'fixture.json'), '{}');
      if (damage === 'lineage-variant') {
        const path = join(directory, 'lineage.json');
        await writeFile(
          path,
          (await readFile(path, 'utf8')).replace(
            `"variantId": ${JSON.stringify(variant.variantId)}`,
            '"variantId": "other-variant"',
          ),
        );
      }
      const after = await reportForRun({ directory, settings });
      if (!after.ok) throw new Error(after.problems.join('; '));
      expect(after.report.quality?.references.cellsBySource).toEqual({
        unresolved: 2,
      });
      expect(
        after.report.examples.every(
          (cell) => cell.evaluationReference?.behaviourEligible === false,
        ),
      ).toBe(true);
    });
  });
  it('qualifies published derived runs and freezes references across candidates', async () => {
    await withWorkflowArea(async (area) => {
      if (area.plan.workflow === undefined) throw new Error('plan missing');
      const plan = {
        ...area.plan,
        protocols: ['chat', 'decision'] as const,
        targets: [dualTarget()],
        workflow: {
          ...area.plan.workflow,
          input: {
            customRules: '',
            projectRules: {
              kind: 'provided' as const,
              text: 'Synthetic project guidance.',
            },
          },
        },
      };
      await area.write(plan);
      await writeFile(
        area.fixturePath,
        JSON.stringify(
          fixtureOf(
            Object.fromEntries(
              cellGrid(plan).cells.map((cell) => [
                cell.cellId,
                fixtureCell({
                  chat: [chatAnswer(3, 8)],
                  decision: [decisionAnswer({ '2': 1 }, { '7': 1 })],
                }),
              ]),
            ),
          ),
        ),
      );
      expect(await area.cli(['run', area.planPath])).toBe(0);
      const references = await replayReferences(
        area.root,
        area.directory,
        plan,
      );
      const original = await inventory(area.runDirectory);
      const variants = {
        variantsVersion: REPLAY_VARIANTS_VERSION,
        variants: [{}, { matrix }],
      };
      const parsed = parseVariants(variants);
      if (!parsed.ok) throw new Error(parsed.problems.join('; '));
      const variantsPath = join(area.directory, 'variants.json'),
        output = join(area.directory, 'derived');
      await writeFile(variantsPath, JSON.stringify(variants));
      const command = parseReplayCommand([
        area.runDirectory,
        '--variants',
        variantsPath,
        '--out',
        output,
        ...references.flatMap((path) => ['--references', path]),
      ]);
      if (typeof command === 'string') throw new Error(command);
      let count = 0;
      const messages: string[] = [];
      const code = await replayRun(
        {
          root: area.root,
          out: (line) => messages.push(line),
          err: (line) => messages.push(line),
        },
        command,
        {
          afterVariant: async () => {
            count += 1;
            if (count !== 1) return;
            for (const path of references) {
              const value: unknown = JSON.parse(await readFile(path, 'utf8'));
              if (value === null || typeof value !== 'object')
                throw new Error('snapshot missing');
              // A valid independent expectation changes between candidates; copies must not.
              const text = JSON.stringify(value).replaceAll(
                '"behaviourReference":"deny"',
                '"behaviourReference":"allow"',
              );
              await writeFile(path, text);
            }
          },
        },
      );
      expect({ code, messages }).toMatchObject({ code: 0 });
      const digests: unknown[] = [];
      for (const variant of parsed.variants) {
        const directory = join(output, variant.variantId);
        const copies = references.map((_, index) =>
          join(directory, 'references', `reference-${String(index + 1)}.json`),
        );
        const report = await reportForRun({
          directory,
          settings: { ...defaultSettings(area.root), references: copies },
        });
        if (!report.ok) throw new Error(report.problems.join('; '));
        expect(report.report.quality?.references.cellsBySource).toEqual({
          human: 4,
        });
        expect(
          report.report.examples.every((cell) => cell.reference === 'deny'),
        ).toBe(true);
        const raw: unknown = JSON.parse(
          await readFile(join(directory, 'lineage.json'), 'utf8'),
        );
        const replay: unknown =
          raw !== null && typeof raw === 'object'
            ? Reflect.get(raw, 'replay')
            : null;
        digests.push(
          replay !== null && typeof replay === 'object'
            ? Reflect.get(replay, 'references')
            : null,
        );
        expect(await readFile(copies[0] ?? '', 'utf8')).toContain(
          '"behaviourReference":"deny"',
        );
      }
      expect(digests[1]).toEqual(digests[0]);
      const selected = parsed.variants[1];
      if (selected === undefined) throw new Error('candidate missing');
      const published = join(output, selected.variantId);
      for (const path of Object.values(
        reportPathsOf(defaultPrefixOf(published)),
      )) {
        expect(await readFile(path, 'utf8')).toContain('Matrix require-nine');
        expect(await readFile(path, 'utf8')).toContain('N0 risk=strict');
      }
      const rebuilt = join(area.directory, 'published-report');
      const copied = references.map((_, index) =>
        join(published, 'references', `reference-${String(index + 1)}.json`),
      );
      expect(
        await area.cli([
          'report',
          published,
          '--out',
          rebuilt,
          ...copied.flatMap((path) => ['--references', path]),
        ]),
      ).toBe(0);
      const saved: unknown = JSON.parse(
        await readFile(reportPathsOf(rebuilt).json, 'utf8'),
      );
      expect(saved).toMatchObject({
        quality: { references: { cellsBySource: { human: 4 } } },
      });
      expect(await inventory(area.runDirectory)).toEqual(original);
      expect(await readFile(references[0] ?? '', 'utf8')).toContain(
        '"behaviourReference":"allow"',
      );
    });
  });
});
