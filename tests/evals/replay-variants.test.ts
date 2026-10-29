/**
 * The variants document, the command line, and the safety refusals around them.
 *
 * A replay's whole output is the claim "this rule produced these numbers", so the
 * one thing it must never do is quietly produce a derivation under a name that
 * describes a different rule. That makes parsing part of the feature rather than
 * plumbing: an unknown axis, a duplicated variant and a document from another format
 * era are all refused, and each refusal names the file and the position.
 *
 * The CLI tests are here rather than in `cli.test.ts` because they assert on the
 * replay command's own contract: which spellings it accepts, which it refuses, and
 * that it writes into a directory of its own.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseCommand } from '../../evals/src/cli/run.js';
import {
  destinationRefusal,
  REPLAY_FILES,
  variantDirectoryOf,
} from '../../evals/src/replay/write.js';
import {
  parseVariants,
  resolveVariant,
  variantDigest,
} from '../../evals/src/replay/variants.js';
import {
  PRODUCTION_THRESHOLDS,
  REPLAY_VARIANTS_VERSION,
} from '../../evals/src/replay/types.js';

import { withArea } from './helpers/report-run.js';
import {
  decisionCellOf,
  decisionForCase,
  decisionRun,
  inventory,
  readJson,
  replay,
  textAt,
} from './helpers/replay.js';

/** A variants document with the given variant list. */
function documentOf(variants: readonly unknown[]): unknown {
  return { variantsVersion: REPLAY_VARIANTS_VERSION, variants };
}

describe('a variant is its axes, and its identity is those axes', () => {
  it('defaults every axis to production, so naming nothing replays the run as decided', () => {
    const variant = resolveVariant({});
    expect(typeof variant).not.toBe('string');
    if (typeof variant === 'string') return;
    expect(variant.answer).toBe('response-text');
    expect(variant.thresholds).toEqual(PRODUCTION_THRESHOLDS);
    expect(variant.settlement).toEqual({ mode: 'ask', channel: 'available' });
    // The label names every axis, so a directory states the rule it holds.
    expect(variant.variantId).toBe('text-strict-at-least-ask-available');
    expect(variant.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('gives two different rules two different labels and two different digests', () => {
    const one = resolveVariant({ thresholds: { risk: 'at-least' } });
    const other = resolveVariant({ thresholds: { authorization: 'strict' } });
    if (typeof one === 'string' || typeof other === 'string') {
      throw new Error('the variants should parse');
    }
    expect(one.variantId).not.toBe(other.variantId);
    expect(one.digest).not.toBe(other.digest);
    expect(one.digest).toBe(
      variantDigest({
        answer: 'response-text',
        thresholds: { risk: 'at-least', authorization: 'at-least' },
        settlement: { mode: 'ask', channel: 'available' },
      }),
    );
  });

  it('keeps the description out of the identity, so renaming does not fork a rule', () => {
    const one = resolveVariant({ description: 'first name' });
    const other = resolveVariant({ description: 'another name' });
    if (typeof one === 'string' || typeof other === 'string') {
      throw new Error('the variants should parse');
    }
    expect(one.digest).toBe(other.digest);
    expect(one.variantId).toBe(other.variantId);
  });

  it('refuses an axis value outside the published set', () => {
    expect(resolveVariant({ answer: 'guess' })).toContain(
      'answer must be one of',
    );
    expect(resolveVariant({ thresholds: { risk: 'half' } })).toContain(
      'thresholds.risk must be one of',
    );
    expect(resolveVariant({ settlement: { mode: 'strict' } })).toContain(
      'settlement.mode must be one of',
    );
    expect(resolveVariant({ settlement: { channel: 'maybe' } })).toContain(
      'settlement.channel must be one of',
    );
  });
});

describe('a variants document is read, not repaired', () => {
  it('accepts a document that names every axis of several variants', () => {
    const parsed = parseVariants(
      documentOf([
        { description: 'production' },
        { answer: 'recorded-parse', thresholds: { authorization: 'strict' } },
        { settlement: { mode: 'no-ask', channel: 'unavailable' } },
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.variants).toHaveLength(3);
    expect(parsed.variants.map((variant) => variant.variantId)).toEqual([
      'text-strict-at-least-ask-available',
      'parsed-strict-strict-ask-available',
      'text-strict-at-least-no-ask-unavailable',
    ]);
  });

  it('refuses a document from another format era', () => {
    const parsed = parseVariants({
      variantsVersion: 'eval-replay-variants-v0',
      variants: [{}],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems.join('\n')).toContain('eval-replay-variants-v0');
  });

  it('refuses two variants with the same axes, because one derivation cannot carry two names', () => {
    const parsed = parseVariants(
      documentOf([{ description: 'first' }, { description: 'second' }]),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems.join('\n')).toContain('repeats the axes');
  });

  it('refuses a mistyped axis instead of falling back to the default', () => {
    // `"answer": 5` must not become the default candidate: the derivation would then be
    // published under a name that says nothing about the mistake.
    const parsed = parseVariants(documentOf([{ answer: 5 }]));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems.join('\n')).toContain('answer must be a string');
  });

  it('refuses an empty document and a non-object one', () => {
    expect(parseVariants(documentOf([])).ok).toBe(false);
    expect(parseVariants({ variantsVersion: REPLAY_VARIANTS_VERSION }).ok).toBe(
      false,
    );
    expect(parseVariants(null).ok).toBe(false);
    expect(parseVariants('a string').ok).toBe(false);
  });
});

describe('the replay command line', () => {
  it('parses a run directory with no flags as the production variant', () => {
    const parsed = parseCommand(['replay', 'run-a']);
    expect(typeof parsed).not.toBe('string');
    if (typeof parsed === 'string') return;
    if (!('variants' in parsed)) throw new Error('wrong command shape');
    expect(parsed.directory).toBe('run-a');
    expect(parsed.output).toBeNull();
    expect(parsed.flags).toEqual({
      answer: null,
      thresholdRisk: null,
      thresholdAuthorization: null,
      mode: null,
      channel: null,
    });
  });

  it('parses every inline axis', () => {
    const parsed = parseCommand([
      'replay',
      'run-a',
      '--answer',
      'recorded-parse',
      '--threshold-risk',
      'at-least',
      '--threshold-auth',
      'strict',
      '--mode',
      'no-ask',
      '--channel',
      'unavailable',
      '--out',
      'derived',
      '--force',
    ]);
    if (typeof parsed === 'string' || !('variants' in parsed)) {
      throw new Error('the command should parse');
    }
    expect(parsed.flags).toEqual({
      answer: 'recorded-parse',
      thresholdRisk: 'at-least',
      thresholdAuthorization: 'strict',
      mode: 'no-ask',
      channel: 'unavailable',
    });
    expect(parsed.output).toBe('derived');
    expect(parsed.force).toBe(true);
  });

  it('refuses a document and an inline axis, because they are two requests', () => {
    const parsed = parseCommand([
      'replay',
      'run-a',
      '--variants',
      'variants.json',
      '--mode',
      'no-ask',
    ]);
    expect(parsed).toContain('two different requests');
  });

  it('refuses an unknown flag, a flag without a value and a missing directory', () => {
    expect(parseCommand(['replay', 'run-a', '--threshold'])).toContain(
      'does not take --threshold',
    );
    expect(parseCommand(['replay', 'run-a', '--mode'])).toContain(
      '--mode needs a value',
    );
    expect(parseCommand(['replay'])).toContain('replay needs a run directory');
  });

  it('refuses an axis value it would not honour, before reading anything', async () => {
    await withArea(async (created) => {
      const result = await replay({
        directory: join(created.path, 'nowhere'),
        output: join(created.path, 'derived'),
        thresholdRisk: 'half',
      });
      expect(result.code).toBe(2);
      expect(result.err.join('\n')).toContain('thresholds.risk must be one of');
    });
  });
});

describe('the derived directory is a run, and a refusal leaves nothing behind', () => {
  it('is readable as a run, with the source fixture copied byte for byte', async () => {
    await withArea(async (created) => {
      const directory = await decisionRun(join(created.path, 'run'), {
        [decisionCellOf('read-named-source-file')]: decisionForCase(
          { '4': 0.9, '5': 0.1 },
          { '8': 0.9, '9': 0.1 },
        ),
      });
      await replay({ directory, output: join(created.path, 'derived') });
      const derived = join(
        created.path,
        'derived/text-strict-at-least-ask-available',
      );
      const source = await inventory(directory);
      const copy = await inventory(derived);
      const fixture = source.find((entry) => entry.path === 'fixture.json');
      expect(copy.find((entry) => entry.path === 'fixture.json')).toEqual(
        fixture,
      );
      const index = await readJson(join(derived, 'index.json'));
      expect(textAt(index, 'runId')).toBe(
        'report-run-replay-text-strict-at-least-ask-available',
      );
      expect(textAt(index, 'fixtureDigest')).toMatch(/^sha256:/);
    });
  });

  it('does not replace an existing derivation, and --force does', async () => {
    await withArea(async (created) => {
      const directory = await decisionRun(join(created.path, 'run'), {
        [decisionCellOf('read-named-source-file')]: decisionForCase(
          { '4': 0.9, '5': 0.1 },
          { '8': 0.9, '9': 0.1 },
        ),
      });
      const first = await replay({
        directory,
        output: join(created.path, 'derived'),
      });
      expect(first.code).toBe(0);
      const second = await replay({
        directory,
        output: join(created.path, 'derived'),
      });
      expect(second.code).toBe(1);
      expect(second.err.join('\n')).toContain(
        'not overwritten without --force',
      );
      const third = await replay({
        directory,
        output: join(created.path, 'derived'),
        force: true,
      });
      expect(third.code).toBe(0);
    });
  });

  it('writes one directory per variant, and only the ones it derived', async () => {
    await withArea(async (created) => {
      const directory = await decisionRun(join(created.path, 'run'), {
        [decisionCellOf('read-named-source-file')]: decisionForCase(
          { '4': 0.9, '5': 0.1 },
          { '8': 0.9, '9': 0.1 },
        ),
      });
      await created.write('variants.json', {
        variantsVersion: 'eval-replay-variants-v1',
        variants: [
          { description: 'production' },
          { thresholds: { risk: 'at-least' } },
          { settlement: { mode: 'no-ask' }, description: 'no human' },
        ],
      });
      const result = await replay({
        directory,
        output: join(created.path, 'derived'),
        variants: join(created.path, 'variants.json'),
      });
      expect(result.code).toBe(0);
      const written = await inventory(join(created.path, 'derived'));
      const directories = [
        ...new Set(written.map((entry) => entry.path.split('/')[0] ?? '')),
      ].sort();
      expect(directories).toEqual([
        'text-at-least-at-least-ask-available',
        'text-strict-at-least-ask-available',
        'text-strict-at-least-no-ask-available',
      ]);
      // Each directory names the description the document gave it. A variant that names
      // no description gets its own axes as the description, so only the explicitly
      // named one reads back as prose.
      for (const [name, description] of [
        [
          'text-at-least-at-least-ask-available',
          'text-at-least-at-least-ask-available',
        ],
        ['text-strict-at-least-no-ask-available', 'no human'],
      ] as const) {
        const lineage = await readJson(
          join(created.path, 'derived', name, REPLAY_FILES.lineage),
        );
        expect(textAt(lineage, 'replay.description')).toBe(description);
        expect(textAt(lineage, 'replay.variantsDocument')).toBe(
          'eval-replay-variants-v1',
        );
      }
    });
  });

  it('writes nothing when the document names no usable variant', async () => {
    await withArea(async (created) => {
      const directory = await decisionRun(join(created.path, 'run'), {
        [decisionCellOf('read-named-source-file')]: decisionForCase(
          { '4': 0.9, '5': 0.1 },
          { '8': 0.9, '9': 0.1 },
        ),
      });
      await created.write('variants.json', {
        variantsVersion: REPLAY_VARIANTS_VERSION,
        variants: [{ thresholds: { risk: 'half' } }],
      });
      const result = await replay({
        directory,
        output: join(created.path, 'derived'),
        variants: join(created.path, 'variants.json'),
      });
      expect(result.code).toBe(2);
      expect(result.err.join('\n')).toContain('thresholds.risk must be one of');
      expect(
        await inventory(join(created.path, 'derived')).catch(() => []),
      ).toEqual([]);
    });
  });
});

describe('the safety checks are their own unit', () => {
  it('refuses a destination equal to, inside, or above the source', () => {
    const source = '/repo/.local/evals/runs/a';
    expect(destinationRefusal({ source, destination: source })).toContain(
      'lies inside',
    );
    expect(
      destinationRefusal({ source, destination: `${source}/nested` }),
    ).toContain('lies inside');
    expect(
      destinationRefusal({ source, destination: '/repo/.local/evals/runs' }),
    ).toContain('contains');
  });

  it('accepts a sibling, including one whose name only looks like the source', () => {
    const source = '/repo/.local/evals/runs/a';
    expect(
      destinationRefusal({ source, destination: '/repo/.local/evals/runs/b' }),
    ).toBeNull();
    // `/runs/ab` must not be read as being inside `/runs/a`.
    expect(
      destinationRefusal({ source, destination: '/repo/.local/evals/runs/ab' }),
    ).toBeNull();
  });

  it('names a variant directory by its own identity', () => {
    expect(
      variantDirectoryOf('/runs', 'text-strict-at-least-ask-available'),
    ).toBe('/runs/text-strict-at-least-ask-available');
  });
});
