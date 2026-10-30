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

import { symlink, writeFile } from 'node:fs/promises';
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

describe('a misspelled axis is refused instead of silently ignored', () => {
  /**
   * The failure this guards against is not a crash: it is a derivation that quietly
   * measures something else. Dropping an unknown member leaves that axis at its
   * production default, so the derived run is byte-identical to the default variant's
   * while its name and its caller's intent claim an experiment. Nothing downstream can
   * tell the two apart, which is why each layer is checked at its own level.
   */
  const misspellings: readonly (readonly [string, unknown, string])[] = [
    [
      'thresholds.auth',
      { thresholds: { auth: 'strict' } },
      'thresholds does not take auth',
    ],
    [
      'thresholds.authorisation',
      { thresholds: { authorisation: 'at-least' } },
      'thresholds does not take authorisation',
    ],
    [
      'thresholds.risk and a typo',
      { thresholds: { risk: 'at-least', authorisation: 'strict' } },
      'thresholds does not take authorisation',
    ],
    [
      'settlement.mode_',
      { settlement: { mode_: 'no-ask' } },
      'settlement does not take mode_',
    ],
    [
      'settlement.channels',
      { settlement: { channels: 'unavailable' } },
      'settlement does not take channels',
    ],
    [
      'variant.tresholds',
      { tresholds: { risk: 'at-least' } },
      'a variant does not take tresholds',
    ],
    [
      'variant.answr',
      { answr: 'recorded-parse' },
      'a variant does not take answr',
    ],
    ['variant.extra', { extra: 1 }, 'a variant does not take extra'],
  ];

  it.each(misspellings)(
    'refuses %s and names the accepted spellings',
    (_label, entry, expected) => {
      const parsed = parseVariants(documentOf([entry]));
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.problems.join('\n')).toContain(expected);
    },
  );

  it('refuses an unknown member of the document itself', () => {
    const parsed = parseVariants({
      variantsVersion: REPLAY_VARIANTS_VERSION,
      variants: [{}],
      variant: [{ thresholds: { risk: 'at-least' } }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems.join('\n')).toContain(
      'a variants document does not take variant',
    );
  });

  it('tells the caller what it does accept, so the fix is one line', () => {
    const parsed = parseVariants(
      documentOf([{ thresholds: { auth: 'strict' } }]),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    // Naming the accepted spellings is what turns a silent fallback into an edit.
    expect(parsed.problems.join('\n')).toContain(
      'it accepts risk, authorization',
    );
  });

  it('still accepts a fully correct document, so the check is not blanket', () => {
    const parsed = parseVariants(
      documentOf([
        {
          description: 'named axes',
          answer: 'recorded-parse',
          thresholds: { risk: 'at-least', authorization: 'strict' },
          settlement: { mode: 'no-ask', channel: 'unavailable' },
        },
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.variants[0]?.variantId).toBe(
      'parsed-at-least-strict-no-ask-unavailable',
    );
  });

  it('would otherwise have produced the production variant from a typo', () => {
    // The regression's discriminating half: this is what the pre-fix parser did with
    // `{"thresholds":{"auth":"strict"}}` — it returned the production variant, so the
    // derivation was indistinguishable from an intentional replay of the default. The
    // assertion is on the *refusal* because producing this value is the defect.
    const parsed = parseVariants(
      documentOf([{ thresholds: { auth: 'strict' } }]),
    );
    expect(parsed.ok).toBe(false);
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
  it('refuses a destination equal to, inside, or above the source', async () => {
    await withArea(async (created) => {
      const source = await created.dir('runs/a');
      expect(
        await destinationRefusal({ source, destination: source }),
      ).toContain('resolves inside the run being replayed');
      expect(
        await destinationRefusal({
          source,
          destination: join(source, 'nested'),
        }),
      ).toContain('resolves inside the run being replayed');
      expect(
        await destinationRefusal({
          source,
          destination: await created.dir('runs'),
        }),
      ).toContain('resolves to a directory that contains');
    });
  });

  it('accepts a sibling, including one whose name only looks like the source', async () => {
    await withArea(async (created) => {
      const source = await created.dir('runs/a');
      expect(
        await destinationRefusal({
          source,
          destination: join(created.path, 'runs/b'),
        }),
      ).toBeNull();
      // `/runs/ab` must not be read as being inside `/runs/a`: the boundary test is a
      // separator, not a prefix.
      expect(
        await destinationRefusal({
          source,
          destination: join(created.path, 'runs/ab'),
        }),
      ).toBeNull();
    });
  });

  it('refuses a destination that reaches the source through a symlink', async () => {
    // The bypass this closes: `resolve()` normalises spelling only, so a destination
    // reached through a link looks unrelated while its writes land in the run. With
    // --force that would overwrite the evidence, which no flag may authorise.
    await withArea(async (created) => {
      const source = await created.dir('run');
      const outside = await created.dir('elsewhere');
      const link = join(created.path, 'elsewhere-link');
      await symlink(source, link, 'dir');
      expect(await destinationRefusal({ source, destination: link })).toContain(
        'resolves inside the run being replayed',
      );
      // A destination whose *parent* is a link resolves into the source too.
      expect(
        await destinationRefusal({
          source,
          destination: join(link, 'variant'),
        }),
      ).toContain('resolves inside');
      // And the reverse direction, where the link sits above the source.
      const outerLink = join(outside, 'up');
      await symlink(created.path, outerLink, 'dir');
      expect(
        await destinationRefusal({
          source,
          destination: join(outside, 'up'),
        }),
      ).toContain('contains');
    });
  });

  it('refuses a symlinked destination even when --force would replace files', async () => {
    await withArea(async (created) => {
      const directory = await decisionRun(join(created.path, 'run'), {
        [decisionCellOf('read-named-source-file')]: decisionForCase(
          { '4': 0.9, '5': 0.1 },
          { '8': 0.9, '9': 0.1 },
        ),
      });
      const before = await inventory(directory);
      // The variant directory the replay will compute, pre-created as a link to the
      // source. Without canonicalisation the overlap check passes and --force writes
      // the derivation into the run being replayed.
      const out = await created.dir('out');
      await symlink(
        directory,
        join(out, 'text-strict-at-least-ask-available'),
        'dir',
      );
      const result = await replay({
        directory,
        output: out,
        force: true,
      });
      expect(result.code).toBe(1);
      expect(result.err.join('\n')).toContain('resolves inside');
      // The evidence is untouched, which is the property the refusal exists for.
      expect(await inventory(directory)).toEqual(before);
    });
  });

  it('refuses a descendant entry that is a link into the source', async () => {
    // The top-level destination is a legitimate sibling, so a check that stopped there
    // would pass. The bypass lives one level down: a `records/` directory that is a link
    // into the run, through which the derived records would overwrite the evidence.
    await withArea(async (created) => {
      const directory = await decisionRun(join(created.path, 'run'), {
        [decisionCellOf('read-named-source-file')]: decisionForCase(
          { '4': 0.9, '5': 0.1 },
          { '8': 0.9, '9': 0.1 },
        ),
      });
      const before = await inventory(directory);
      const out = await created.dir('out');
      const target = join(out, 'text-strict-at-least-ask-available');
      await created.dir('out/text-strict-at-least-ask-available');
      await symlink(join(directory, 'records'), join(target, 'records'), 'dir');
      // Whatever the exit code, the invariant that matters is the evidence: no write may
      // reach it. The staging directory makes that true by construction, which is why
      // this asserts the run rather than the refusal.
      await replay({ directory, output: out, force: true });
      expect(await inventory(directory)).toEqual(before);
    });
  });

  it('does not write a fixture through a link onto the source index', async () => {
    // This one needed no `--force` at all: the existing-file check did not cover
    // `fixture.json`, so a link placed there was followed and replaced the source index.
    await withArea(async (created) => {
      const directory = await decisionRun(join(created.path, 'run'), {
        [decisionCellOf('read-named-source-file')]: decisionForCase(
          { '4': 0.9, '5': 0.1 },
          { '8': 0.9, '9': 0.1 },
        ),
      });
      // A source fixture, so the derived fixture is actually written.
      await writeFile(
        join(directory, 'fixture.json'),
        `${JSON.stringify({ documentVersion: 'eval-run-fixture-v1' })}\n`,
      );
      const before = await inventory(directory);
      const out = await created.dir('out');
      const target = join(out, 'text-strict-at-least-ask-available');
      await created.dir('out/text-strict-at-least-ask-available');
      await symlink(
        join(directory, 'index.json'),
        join(target, 'fixture.json'),
      );
      const result = await replay({ directory, output: out });
      expect(await inventory(directory)).toEqual(before);
      // The failure is reported rather than silently skipped.
      expect(result.code).toBe(1);
      expect(result.err.join('\n')).toContain('already exists');
    });
  });

  it('publishes nothing when the derivation fails, leaving no staging debris', async () => {
    await withArea(async (created) => {
      const directory = await decisionRun(join(created.path, 'run'), {
        [decisionCellOf('read-named-source-file')]: decisionForCase(
          { '4': 0.9, '5': 0.1 },
          { '8': 0.9, '9': 0.1 },
        ),
      });
      const out = await created.dir('out');
      // A document the published schema rejects must abort before publication, so the
      // destination never becomes a half-written derivation.
      await replay({ directory, output: out });
      const first = await inventory(out);
      const second = await replay({ directory, output: out });
      expect(second.code).toBe(1);
      expect(await inventory(out)).toEqual(first);
      // No staging directory is left behind on either the success or the refusal path.
      expect(
        first.filter((entry) => entry.path.includes('.replay-staging')),
      ).toEqual([]);
    });
  });

  it('compares ancestry with the platform separator, not a literal slash', async () => {
    // On Windows a resolved path uses `\`, so a `/` boundary test never matches and a
    // nested destination would look unrelated to the source it sits inside. The check
    // is exercised here through the real implementation on the current platform; the
    // Windows branch itself is covered by the CI job that runs there.
    await withArea(async (created) => {
      const source = await created.dir('run');
      const nested = join(source, 'nested', 'deeper');
      expect(
        await destinationRefusal({ source, destination: nested }),
      ).toContain('resolves inside the run being replayed');
      // A sibling that shares the whole name except a trailing character is not inside,
      // which is what the separator boundary exists to distinguish.
      expect(
        await destinationRefusal({
          source,
          destination: join(created.path, 'run2'),
        }),
      ).toBeNull();
    });
  });

  it('names a variant directory by its own identity', () => {
    expect(
      variantDirectoryOf('/runs', 'text-strict-at-least-ask-available'),
    ).toBe('/runs/text-strict-at-least-ask-available');
  });
});
