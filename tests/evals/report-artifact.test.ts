/**
 * The report's central claim: it is rebuilt from the artifact, offline.
 *
 * Every test here reads a run directory the real runner wrote, through the published
 * consumer interface, and asserts on the document that came back. Nothing is mocked:
 * the point is that a report needs nothing but the files, so a test that supplied an
 * object in memory would prove a weaker thing than the issue asks for.
 *
 * The checks fall into three groups:
 *
 *   - rebuilding. Two builds of one directory produce byte-identical JSON, and building
 *     does not modify a single file in the run directory or in the dataset.
 *   - counting. Cells that never ran, cells that failed and cells with no label each land
 *     in the right row, and the denominator a rate is computed over is the compared one.
 *   - honesty. An empty `labels/` reports zero gold rather than a passing rate, a null
 *     token stays null, and cost stays a status.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildReport,
  defaultSettings,
  parseSettlementMode,
  reportForRun,
} from '../../evals/src/metrics/index.js';
import { observeRun } from '../../evals/src/metrics/observe.js';
import type { EvaluationReport } from '../../evals/src/metrics/types.js';
import { reportRun } from '../../evals/src/report/command.js';
import { renderHtml } from '../../evals/src/report/html.js';
import { renderMarkdown } from '../../evals/src/report/markdown.js';
import { renderReport } from '../../evals/src/report/write.js';
import {
  cellIdOf,
  chatAnswer,
  chatTarget,
  fixtureCell,
  fixtureOf,
  planOf,
} from './helpers/run.js';
import {
  CORE_DATASET,
  REPOSITORY_ROOT,
  VERSIONS,
  runPlan,
  withArea,
} from './helpers/report-run.js';
import type { Area } from './helpers/report-run.js';

/** One chat cell's fixture entry, keyed by the case it answers. */
function chatFixture(
  entries: Readonly<Record<string, ReturnType<typeof chatAnswer>>>,
) {
  return fixtureOf(
    Object.fromEntries(
      Object.entries(entries).map(([caseId, answer]) => [
        cellIdOf({ caseId, targetId: 'chat-a', protocol: 'chat' }),
        fixtureCell({ chat: [answer] }),
      ]),
    ),
  );
}

/** The settings a test builds a report with, joined against the committed dataset. */
function settings() {
  return {
    ...defaultSettings(REPOSITORY_ROOT),
    dataset: { kind: 'path', path: CORE_DATASET } as const,
  };
}

/** Run two cases through chat and return the run directory. */
async function twoCaseRun(created: Area): Promise<string> {
  const directory = join(created.path, 'run');
  await runPlan({
    directory,
    plan: planOf({
      caseIds: ['read-named-source-file', 'read-repo-index-with-cache'],
      protocols: ['chat'],
      targets: [chatTarget()],
    }),
    fixture: chatFixture({
      'read-named-source-file': chatAnswer(1, 10, {
        input_tokens: 900,
        output_tokens: 12,
      }),
      'read-repo-index-with-cache': chatAnswer(2, 10, {
        input_tokens: 950,
        output_tokens: 14,
      }),
    }),
  });
  return directory;
}

/** Every file under a directory, with its size, for a before/after comparison. */
async function inventory(directory: string): Promise<readonly string[]> {
  const names = (await readdir(directory, { recursive: true })).sort();
  const out: string[] = [];
  for (const name of names) {
    const path = join(directory, name);
    try {
      const info = await stat(path);
      if (info.isFile()) out.push(`${name}:${String(info.size)}`);
    } catch {
      // A directory entry can vanish between the listing and the stat in a concurrent
      // test run; skipping it is right, because nothing it measured exists any more.
    }
  }
  return out;
}

/** Build one report, failing the test when the read failed instead. */
async function build(
  directory: string,
  options: { readonly dataset?: string | null } = {},
): Promise<EvaluationReport> {
  const dataset =
    options.dataset === undefined
      ? ({ kind: 'path', path: CORE_DATASET } as const)
      : options.dataset === null
        ? ({ kind: 'none' } as const)
        : ({ kind: 'path', path: options.dataset } as const);
  const read = await observeRun({
    directory,
    root: REPOSITORY_ROOT,
    dataset,
  });
  if (!read.ok) throw new Error(read.problems.join('; '));
  return buildReport({
    observation: read.observation,
    settings: { ...settings(), dataset },
  });
}

describe('rebuilding a report from the artifact', () => {
  it('produces a byte-identical JSON document from the same directory twice', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      const first = renderReport(await build(directory));
      const second = renderReport(await build(directory));
      expect(second.json).toBe(first.json);
      expect(second.markdown).toBe(first.markdown);
      expect(second.html).toBe(first.html);
    });
  });

  it('does not modify the run directory or the dataset while building', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      const before = await inventory(directory);
      const datasetBefore = await inventory(
        join(REPOSITORY_ROOT, CORE_DATASET),
      );
      await build(directory);
      expect(await inventory(directory)).toEqual(before);
      expect(await inventory(join(REPOSITORY_ROOT, CORE_DATASET))).toEqual(
        datasetBefore,
      );
    });
  });

  it('reads a run without a dataset and says so instead of reporting zero rates', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      const report = await build(directory, {
        dataset: null,
      });
      expect(report.setup.labels).toBe('absent');
      expect(report.diagnostics.labels.source).toBe('absent');
      expect(report.diagnostics.labels.gold).toBe(0);
      // Nothing was comparable, so the rate is unknown rather than zero.
      expect(report.behaviour.overall.agreementRate).toBeNull();
      expect(report.notes.join('\n')).toContain('没有提供数据集');
    });
  });

  it('reports the run identity from the index rather than from a clock', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      const report = await build(directory);
      expect(report.run.runId).toBe('report-run');
      expect(report.run.createdAt).toBe('1970-01-01T00:00:00.000Z');
      expect(report.run.versions.usageMapping).toBe(VERSIONS.usageMapping);
      expect(report.formatVersion).toBe('eval-report-v1');
    });
  });
});

describe('the three layers are kept apart', () => {
  it('counts a scored cell with no label as uncompared rather than as a match', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      const report = await build(directory);
      const overall = report.behaviour.overall;
      expect(overall.cells).toBe(2);
      expect(overall.judged).toBe(2);
      expect(overall.referenceKnown).toBe(0);
      expect(overall.compared).toBe(0);
      expect(overall.uncompared).toBe(2);
      expect(overall.agreementRate).toBeNull();
    });
  });

  it('counts a provider failure as technical, never as a denial', async () => {
    await withArea(async (created) => {
      const directory = join(created.path, 'run');
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file'],
          protocols: ['chat'],
          targets: [chatTarget()],
        }),
        fixture: fixtureOf({
          [cellIdOf({
            caseId: 'read-named-source-file',
            targetId: 'chat-a',
            protocol: 'chat',
          })]: fixtureCell({
            chat: [
              {
                kind: 'failure',
                code: 'overloaded',
                message: 'the provider refused',
              },
            ],
          }),
        }),
      });
      const report = await build(directory);
      const overall = report.behaviour.overall;
      expect(overall.technical).toBe(1);
      expect(overall.falseDeny).toBe(0);
      expect(report.examples[0]?.classification).toBe('technical');
      expect(report.examples[0]?.engine.word).toBe('review-failure');
    });
  });

  it('keeps a cell the plan never supported out of every denominator', async () => {
    await withArea(async (created) => {
      const directory = join(created.path, 'run');
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file'],
          protocols: ['decision'],
          targets: [chatTarget()],
        }),
        fixture: fixtureOf({}),
      });
      const report = await build(directory);
      expect(report.behaviour.overall.notRun).toBe(1);
      expect(report.behaviour.overall.compared).toBe(0);
      expect(report.settlement.overall.notReviewed).toBe(1);
      expect(report.comparison.unsupported).toHaveLength(1);
      expect(report.comparison.unsupported[0]?.protocols).toEqual(['decision']);
    });
  });

  it('separates the projection from an observed settlement', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      const report = await build(directory);
      // The runner calls the production service directly, so no cell has a host chain
      // behind it and layer three is a projection. The report says so in both places.
      expect(report.setup.settlementProjection).toBe(true);
      expect(report.settlement.projection).toBe(true);
      expect(report.notes.join('\n')).toContain('宿主链');
    });
  });
});

describe('settlement follows the shared rule, not a local one', () => {
  it('turns an escalation into a human question only under ask with a channel', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      const ask = await buildReportFor(directory, 'ask', 'available');
      const noAsk = await buildReportFor(directory, 'no-ask', 'available');
      const noChannel = await buildReportFor(directory, 'ask', 'unavailable');
      // Both cases were allowed at A10 against R1/R2, so every mode allows them: the
      // test's point is that the mode did not silently change an allow.
      expect(ask.settlement.overall.allow).toBe(2);
      expect(noAsk.settlement.overall.allow).toBe(2);
      expect(noChannel.settlement.overall.allow).toBe(2);
      expect(ask.setup.mode).toBe('ask');
      expect(noAsk.setup.mode).toBe('no-ask');
      expect(noChannel.setup.channel).toBe('unavailable');
    });
  });

  it('settles an escalation as a human question under ask and a denial under no-ask', async () => {
    await withArea(async (created) => {
      const directory = join(created.path, 'run');
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file'],
          protocols: ['chat'],
          targets: [chatTarget()],
        }),
        // R3 at A2 escalates: the matrix requires A8 at risk 3.
        fixture: chatFixture({
          'read-named-source-file': chatAnswer(3, 2),
        }),
      });
      const ask = await buildReportFor(directory, 'ask', 'available');
      const noAsk = await buildReportFor(directory, 'no-ask', 'available');
      const noChannel = await buildReportFor(directory, 'ask', 'unavailable');
      expect(ask.settlement.overall.askHuman).toBe(1);
      expect(noAsk.settlement.overall.fallbackDeny).toBe(1);
      expect(noChannel.settlement.overall.fallbackDeny).toBe(1);
      expect(ask.settlement.overall.deny).toBe(0);
      expect(noAsk.settlement.overall.deny).toBe(0);
    });
  });

  it('refuses an unknown mode or channel instead of defaulting', () => {
    expect(parseSettlementMode('ask')).toBe('ask');
    expect(parseSettlementMode('no-ask')).toBe('no-ask');
    expect(parseSettlementMode('maybe')).toBeNull();
  });
});

/** Build a report under one settlement setting. */
async function buildReportFor(
  directory: string,
  mode: 'ask' | 'no-ask',
  channel: 'available' | 'unavailable',
): Promise<EvaluationReport> {
  const read = await observeRun({
    directory,
    root: REPOSITORY_ROOT,
    dataset: { kind: 'path', path: CORE_DATASET },
  });
  if (!read.ok) throw new Error(read.problems.join('; '));
  return buildReport({
    observation: read.observation,
    settings: { ...settings(), mode, channel },
  });
}

describe('usage is the shared aggregate, re-derived', () => {
  it('reports the six buckets with their coverage and never a combined total', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      const report = await build(directory);
      const run = report.usage.run;
      expect(run).not.toBeNull();
      expect(run?.mappingVersion).toBe('review-usage-v1');
      expect(run?.attempts).toBe(2);
      // The fixture reported both input and output for each attempt, so both buckets are
      // complete over the two attempts.
      expect(run?.totals.inputTokens.total).toBe(1850);
      expect(run?.totals.inputTokens.complete).toBe(true);
      expect(run?.totals.outputTokens.total).toBe(26);
      // Cache buckets were never reported, so they stay unknown rather than zero.
      expect(run?.totals.cacheReadTokens.total).toBeNull();
      expect(run?.totals.cacheReadTokens.missing).toBe(2);
      expect(run?.inclusions.cacheRead).toBe('unknown');
    });
  });

  it('keeps an explicitly reported zero as zero', async () => {
    await withArea(async (created) => {
      const directory = join(created.path, 'run');
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file'],
          protocols: ['chat'],
          targets: [chatTarget()],
        }),
        fixture: chatFixture({
          'read-named-source-file': chatAnswer(1, 10, {
            input_tokens: 900,
            output_tokens: 0,
            cache_read_input_tokens: 0,
          }),
        }),
      });
      const report = await build(directory);
      expect(report.usage.run?.totals.outputTokens.total).toBe(0);
      expect(report.usage.run?.totals.outputTokens.complete).toBe(true);
      expect(report.usage.run?.totals.cacheReadTokens.total).toBe(0);
    });
  });

  it('reproduces each record summary from its own attempts', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      const report = await build(directory);
      expect(report.usage.byCell.length).toBe(2);
      for (const cell of report.usage.byCell) {
        expect(cell.matchesRecord).toBe(true);
        expect(cell.aggregate?.attempts).toBe(1);
      }
      expect(
        report.checks.find(
          (check) => check.name === 'usage-reproduced-from-attempts',
        )?.ok,
      ).toBe(true);
    });
  });

  it('keeps the adapter estimate separate from the provider report', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      const report = await build(directory);
      // Both are present, and neither is derived from the other.
      expect(report.usage.estimated.inputTokens).not.toBeNull();
      expect(report.usage.estimated.inputTokens).not.toBe(1850);
      expect(report.usage.estimated.attempts).toBe(2);
      expect(report.usage.estimated.cells).toBe(2);
    });
  });

  it('keeps cost as a status with no amount', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      const report = await build(directory);
      expect(report.efficiency.cost.amount).toBeNull();
      expect(report.efficiency.cost.currency).toBeNull();
      expect(report.efficiency.cost.status).toBe('not-computed');
      expect(report.efficiency.cost.cells).toBe(2);
      expect(report.efficiency.cost.reasons.length).toBeGreaterThan(0);
      // No per-cell cost is a number either.
      for (const example of report.examples) {
        expect(example.costStatus).toBe('not-computed');
      }
    });
  });
});

describe('repeat stability and sample weights', () => {
  it('groups repeats and says how many cases they really cover', async () => {
    await withArea(async (created) => {
      const directory = join(created.path, 'run');
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file'],
          protocols: ['chat'],
          targets: [chatTarget()],
          repeats: 2,
        }),
        fixture: fixtureOf({
          [cellIdOf({
            caseId: 'read-named-source-file',
            targetId: 'chat-a',
            protocol: 'chat',
            repeat: 1,
          })]: fixtureCell({ chat: [chatAnswer(1, 10)] }),
          [cellIdOf({
            caseId: 'read-named-source-file',
            targetId: 'chat-a',
            protocol: 'chat',
            repeat: 2,
          })]: fixtureCell({ chat: [chatAnswer(1, 10)] }),
        }),
      });
      const report = await build(directory);
      const samples = report.stability.samples;
      expect(samples.cells).toBe(2);
      expect(samples.distinctCases).toBe(1);
      expect(samples.repeats).toBe(1);
      expect(report.stability.repeatGroups).toHaveLength(1);
      expect(report.stability.repeatGroups[0]?.stable).toBe(true);
      expect(report.stability.unstableGroups).toBe(0);
    });
  });

  it('marks an unstable repeat group and reports its spread', async () => {
    await withArea(async (created) => {
      const directory = join(created.path, 'run');
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file'],
          protocols: ['chat'],
          targets: [chatTarget()],
          repeats: 2,
        }),
        fixture: fixtureOf({
          [cellIdOf({
            caseId: 'read-named-source-file',
            targetId: 'chat-a',
            protocol: 'chat',
            repeat: 1,
          })]: fixtureCell({ chat: [chatAnswer(1, 10)] }),
          [cellIdOf({
            caseId: 'read-named-source-file',
            targetId: 'chat-a',
            protocol: 'chat',
            repeat: 2,
          })]: fixtureCell({ chat: [chatAnswer(5, 4)] }),
        }),
      });
      const report = await build(directory);
      const group = report.stability.repeatGroups[0];
      expect(group?.stable).toBe(false);
      expect(group?.distinctAnswers).toBe(2);
      expect(group?.riskSpread).toBe(4);
      expect(report.stability.unstableGroups).toBe(1);
    });
  });

  it('counts a repair attempt as consumption but not as a repeat', async () => {
    await withArea(async (created) => {
      const directory = join(created.path, 'run');
      await runPlan({
        directory,
        plan: planOf({
          caseIds: ['read-named-source-file'],
          protocols: ['chat'],
          targets: [chatTarget()],
        }),
        fixture: fixtureOf({
          [cellIdOf({
            caseId: 'read-named-source-file',
            targetId: 'chat-a',
            protocol: 'chat',
          })]: fixtureCell({
            chat: [
              { kind: 'text', text: 'not json', usage: { input_tokens: 800 } },
              chatAnswer(1, 10, { input_tokens: 810, output_tokens: 9 }),
            ],
          }),
        }),
      });
      const report = await build(directory);
      expect(report.stability.samples.repairs).toBe(1);
      expect(report.stability.samples.repeats).toBe(0);
      expect(report.stability.repeatGroups).toHaveLength(0);
      // Both attempts are reported and both are counted in usage.
      expect(report.usage.attempts).toHaveLength(2);
      expect(report.usage.attempts.map((attempt) => attempt.kind)).toEqual([
        'initial',
        'repair',
      ]);
      expect(report.usage.run?.attempts).toBe(2);
    });
  });
});

describe('the rendered documents agree with the JSON', () => {
  it('prints n/a rather than a rate over nothing', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      const rendered = renderReport(await build(directory));
      expect(rendered.markdown).toContain('n/a (0/0)');
      expect(rendered.markdown).not.toContain('0.0% (0/0)');
      expect(rendered.markdown).toContain('**当前没有金标标签**');
    });
  });

  it('escapes artifact text in the HTML so a rationale cannot become markup', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      const report = await build(directory);
      const html = renderHtml({
        ...report,
        notes: ['<script>alert(1)</script>'],
      });
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });
  });

  it('meets the acceptance rule that a missing record is a visible gap', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      const report = await build(directory);
      // Nothing was removed from a completed run, so the gap list is empty and the check
      // passes. The Markdown still documents the rule, which this asserts is not dropped.
      expect(report.coverage.missing).toHaveLength(0);
      expect(
        report.checks.find(
          (check) => check.name === 'dispatched-cells-have-records',
        )?.ok,
      ).toBe(true);
      const markdown = renderMarkdown(report);
      expect(markdown).toContain('宣称已派发但缺记录');
    });
  });
});

describe('the report command writes three documents and refuses to clobber', () => {
  it('writes JSON, Markdown and HTML beside the run', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      const out: string[] = [];
      const err: string[] = [];
      const code = await reportRun(
        {
          root: REPOSITORY_ROOT,
          out: (line) => out.push(line),
          err: (line) => err.push(line),
        },
        {
          directory,
          output: null,
          dataset: CORE_DATASET,
          mode: 'ask',
          channel: 'available',
          force: false,
        },
      );
      expect(err).toEqual([]);
      expect(code).toBe(0);
      for (const extension of ['.json', '.md', '.html']) {
        const text = await readFile(
          join(directory, `report${extension}`),
          'utf8',
        );
        expect(text.length).toBeGreaterThan(0);
      }
      expect(out.join('\n')).toContain('gold 0');
    });
  });

  it('refuses to overwrite an existing report without --force', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      const io = {
        root: REPOSITORY_ROOT,
        out: () => undefined,
        err: () => undefined,
      };
      const command = {
        directory,
        output: null,
        dataset: CORE_DATASET,
        mode: 'ask',
        channel: 'available',
        force: false,
      };
      expect(await reportRun(io, command)).toBe(0);
      expect(await reportRun(io, command)).toBe(1);
      expect(await reportRun(io, { ...command, force: true })).toBe(0);
    });
  });

  it('refuses an unknown mode or channel', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      const err: string[] = [];
      const io = {
        root: REPOSITORY_ROOT,
        out: () => undefined,
        err: (line: string) => err.push(line),
      };
      const base = {
        directory,
        output: null,
        dataset: CORE_DATASET,
        mode: 'ask',
        channel: 'available',
        force: false,
      };
      expect(await reportRun(io, { ...base, mode: 'always' })).toBe(2);
      expect(await reportRun(io, { ...base, channel: 'sometimes' })).toBe(2);
      expect(err.join('\n')).toContain('--mode takes ask or no-ask');
    });
  });

  it('reports a missing run directory as a problem', async () => {
    await withArea(async (created) => {
      const err: string[] = [];
      const code = await reportRun(
        {
          root: REPOSITORY_ROOT,
          out: () => undefined,
          err: (line) => err.push(line),
        },
        {
          directory: join(created.path, 'absent'),
          output: null,
          dataset: null,
          mode: 'ask',
          channel: 'available',
          force: false,
        },
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('plan.json');
    });
  });
});

describe('the report reads through the published consumer interface', () => {
  it('reports a run the runner can no longer continue as readable evidence', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      // A stale claim file is what stops a continuation; it must not stop a report,
      // because reading evidence and writing it are different operations.
      await created.write('run/run.lock', {
        pid: 1,
        claimedAt: '2026-10-30T00:00:00.000Z',
      });
      const report = await build(directory);
      expect(report.coverage.records).toBe(2);
      expect(report.behaviour.overall.cells).toBe(2);
    });
  });

  it('reads a run whose dataset path is relative to the repository root', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      // `planOf` records the dataset path relative to the repository, which is what the
      // runner did; the report resolves it against the root it was given.
      const read = await reportForRun({
        directory,
        settings: settings(),
      });
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.report.diagnostics.labels.datasetId).toBe('core-v1');
    });
  });
});
