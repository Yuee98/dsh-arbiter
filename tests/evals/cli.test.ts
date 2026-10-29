/**
 * The command line, end to end.
 *
 * These tests run the real commands against a real temporary dataset, because the
 * claim being made is that a person can annotate and file the result using only the
 * README and the exported material. Anything mocked here would leave exactly that
 * claim untested.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseCommand, runCli } from '../../evals/src/cli/run.js';
import type { CliIo } from '../../evals/src/cli/run.js';
import { inputHashOf } from '../../evals/src/data/eligibility.js';
import type { AnnotationDocument } from '../../evals/src/data/types.js';
import {
  approvedTarget,
  input,
  manifest,
  reviewCase,
  reviewLabel,
} from './fixtures/documents.js';
import { REPOSITORY_ROOT, withDataset } from './helpers/dataset.js';
import { readDocument, schemas } from './helpers/documents.js';

const hash = inputHashOf(input());

/** Collect what a command wrote, so an assertion can read it back. */
function recorder(root: string): {
  readonly io: CliIo;
  readonly out: readonly string[];
  readonly err: readonly string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { root, out: (line) => out.push(line), err: (line) => err.push(line) },
    out,
    err,
  };
}

/** Replace every entry's target, keeping the rest of the exported document. */
function fillEveryEntry(
  document: AnnotationDocument,
  target: AnnotationDocument['entries'][number]['target'],
): AnnotationDocument {
  return {
    ...document,
    entries: document.entries.map((entry) => ({ ...entry, target })),
  };
}

/** Write one coherent dataset into a temporary directory. */
async function seed(
  dataset: { write(relative: string, document: unknown): Promise<void> },
  overrides: { readonly labels?: boolean } = {},
): Promise<void> {
  await dataset.write('manifest.json', manifest(['case-a']));
  await dataset.write('cases/case-a.json', reviewCase());
  if (overrides.labels !== false) {
    await dataset.write('labels/case-a.json', reviewLabel(hash));
  }
}

describe('argument parsing', () => {
  it('reads a command and its dataset', () => {
    expect(parseCommand(['check', 'evals/datasets/core-v1'])).toEqual({
      name: 'check',
      dataset: 'evals/datasets/core-v1',
      out: null,
      fill: null,
      date: null,
      write: false,
    });
  });

  it('refuses a command it does not implement', () => {
    // `run` is a real command now, so the check names one that never will be.
    expect(parseCommand(['deploy', 'x'])).toContain('unknown command deploy');
  });

  it('refuses an unknown option instead of ignoring it', () => {
    // An ignored option is how a run silently does something other than what was
    // asked; refusing it is the only safe reading.
    expect(parseCommand(['check', 'x', '--dry-run'])).toContain(
      'unknown option --dry-run',
    );
  });

  it('requires an output path for export and a fill for import', () => {
    expect(parseCommand(['export', 'x'])).toBe('export needs --out <file>');
    expect(parseCommand(['import', 'x'])).toBe('import needs --fill <file>');
  });

  it('prints usage with no arguments', () => {
    expect(parseCommand([])).toContain('usage: evals <command>');
  });

  it('treats a help request as a usage question', () => {
    for (const flag of ['--help', '-h', 'help']) {
      expect(parseCommand([flag])).toContain('usage: evals <command>');
    }
  });

  it('parses check-all, which takes no dataset', () => {
    expect(parseCommand(['check-all'])).toEqual({
      name: 'check-all',
      dataset: null,
      out: null,
      fill: null,
      date: null,
      write: false,
    });
    expect(parseCommand(['check-all', 'extra'])).toContain(
      'check-all takes no dataset',
    );
  });
});

describe('check', () => {
  it('passes a coherent dataset', async () => {
    await withDataset(async (dataset) => {
      await seed(dataset);
      const { io, out, err } = recorder(REPOSITORY_ROOT);
      expect(await runCli(['check', dataset.path], io)).toBe(0);
      expect(err).toEqual([
        'note labels/case-a.json: no model opinion is recorded for approved case case-a',
      ]);
      expect(out[0]).toContain('dataset demo: 1 cases, 1 gold labels');
    });
  });

  it('fails a dataset whose label no longer matches its input', async () => {
    await withDataset(async (dataset) => {
      await seed(dataset);
      await dataset.write(
        'cases/case-a.json',
        reviewCase({ input: input({ hint: 'changed after labelling' }) }),
      );
      const { io, err } = recorder(REPOSITORY_ROOT);
      expect(await runCli(['check', dataset.path], io)).toBe(1);
      expect(err).toEqual([
        expect.stringContaining('this label cannot count (input-changed)'),
      ]);
    });
  });

  it('fails a dataset with no manifest', async () => {
    await withDataset(async (dataset) => {
      await dataset.write('cases/case-a.json', reviewCase());
      const { io, err } = recorder(REPOSITORY_ROOT);
      expect(await runCli(['check', dataset.path], io)).toBe(1);
      expect(err).toEqual([
        expect.stringContaining('manifest.json does not exist'),
        expect.stringContaining(
          'a dataset needs a manifest.json matching manifest.schema.json',
        ),
      ]);
    });
  });

  it('reports a document that is not valid JSON with its file', async () => {
    await withDataset(async (dataset) => {
      await dataset.write('manifest.json', manifest(['case-a']));
      await mkdir(join(dataset.path, 'cases'), { recursive: true });
      await writeFile(join(dataset.path, 'cases/case-a.json'), '{,}');
      const { io, err } = recorder(REPOSITORY_ROOT);
      expect(await runCli(['check', dataset.path], io)).toBe(1);
      expect(err[0]).toContain('cases/case-a.json');
    });
  });
});

describe('export and import', () => {
  it('writes a blank pack with no decision in it', async () => {
    await withDataset(async (dataset) => {
      await seed(dataset);
      const pack = join(dataset.path, 'pack.json');
      const { io, out } = recorder(REPOSITORY_ROOT);
      expect(
        await runCli(
          ['export', dataset.path, '--out', pack, '--date', '2026-10-29'],
          io,
        ),
      ).toBe(0);
      expect(out[0]).toContain('wrote 1 blank entries');
      const document = await readDocument(pack, schemas.annotation);
      expect(document.exportedAt).toBe('2026-10-29');
      expect(document.entries[0]?.target.status).toBe('pending');
      expect(JSON.stringify(document)).not.toContain('"reviews"');
    });
  });

  it('exports a fresh blank pack while committed labels are stale', async () => {
    await withDataset(async (dataset) => {
      await seed(dataset);
      // The documented recovery from a stale label is to re-export and decide the
      // case again, so export must not be blocked by the very problem it fixes.
      await dataset.write(
        'cases/case-a.json',
        reviewCase({ input: input({ hint: 'changed after labelling' }) }),
      );
      const pack = join(dataset.path, 'pack.json');
      const { io, out, err } = recorder(REPOSITORY_ROOT);
      expect(await runCli(['export', dataset.path, '--out', pack], io)).toBe(0);
      expect(out[0]).toContain('wrote 1 blank entries');
      expect(err).toEqual([
        expect.stringContaining(
          'note labels/case-a.json: this label cannot count (input-changed)',
        ),
      ]);
      // check still refuses: a dataset claiming an adjudication nobody made must
      // not pass, even though the pack can be regenerated from it.
      const checking = recorder(REPOSITORY_ROOT);
      expect(await runCli(['check', dataset.path], checking.io)).toBe(1);
    });
  });

  it('refuses to export from a dataset whose cases or manifest are unsound', async () => {
    await withDataset(async (dataset) => {
      await dataset.write('cases/case-a.json', reviewCase());
      const { io, err } = recorder(REPOSITORY_ROOT);
      expect(
        await runCli(
          ['export', dataset.path, '--out', join(dataset.path, 'pack.json')],
          io,
        ),
      ).toBe(1);
      // Both are reported: the missing file, and then that a dataset needs one.
      expect(err).toEqual([
        'problem manifest.json: manifest.json does not exist',
        'problem manifest.json: a dataset needs a manifest.json matching manifest.schema.json',
      ]);
    });
  });

  it('turns a filled pack into a label file', async () => {
    await withDataset(async (dataset) => {
      await seed(dataset, { labels: false });
      const pack = join(dataset.path, 'pack.json');
      const exported = recorder(REPOSITORY_ROOT);
      expect(
        await runCli(['export', dataset.path, '--out', pack], exported.io),
      ).toBe(0);
      const document = await readDocument(pack, schemas.annotation);
      const filled: AnnotationDocument = {
        ...document,
        entries: document.entries.map((entry) => ({
          ...entry,
          target: approvedTarget(),
        })),
      };
      await writeFile(pack, `${JSON.stringify(filled, null, 2)}\n`);

      const imported = recorder(REPOSITORY_ROOT);
      expect(
        await runCli(
          ['import', dataset.path, '--fill', pack, '--write'],
          imported.io,
        ),
      ).toBe(0);
      expect(imported.out).toContain('wrote 1 labels');
      const label = await readDocument(
        join(dataset.path, 'labels/case-a.json'),
        schemas.label,
      );
      expect(label.caseId).toBe('case-a');
      expect(label.inputHash).toBe(hash);
      expect(label.target.status).toBe('approved');
    });
  });

  it('imports without writing when --write is absent', async () => {
    await withDataset(async (dataset) => {
      await seed(dataset, { labels: false });
      const pack = join(dataset.path, 'pack.json');
      const exported = recorder(REPOSITORY_ROOT);
      await runCli(['export', dataset.path, '--out', pack], exported.io);
      const document = await readDocument(pack, schemas.annotation);
      await writeFile(
        pack,
        `${JSON.stringify(fillEveryEntry(document, approvedTarget()), null, 2)}\n`,
      );
      const imported = recorder(REPOSITORY_ROOT);
      expect(
        await runCli(['import', dataset.path, '--fill', pack], imported.io),
      ).toBe(0);
      expect(imported.out).toContain(
        '1 labels are ready; re-run with --write to store them',
      );
      await expect(
        readFile(join(dataset.path, 'labels/case-a.json'), 'utf8'),
      ).rejects.toThrow();
    });
  });

  it('refuses a fill whose input no longer matches the case', async () => {
    await withDataset(async (dataset) => {
      await seed(dataset, { labels: false });
      const pack = join(dataset.path, 'pack.json');
      const exported = recorder(REPOSITORY_ROOT);
      await runCli(['export', dataset.path, '--out', pack], exported.io);
      const document = await readDocument(pack, schemas.annotation);
      const edited: AnnotationDocument = {
        ...document,
        entries: document.entries.map((entry) => ({
          ...entry,
          input: input({ hint: 'edited after export' }),
          target: approvedTarget(),
        })),
      };
      await writeFile(pack, `${JSON.stringify(edited, null, 2)}\n`);

      const imported = recorder(REPOSITORY_ROOT);
      expect(
        await runCli(
          ['import', dataset.path, '--fill', pack, '--write'],
          imported.io,
        ),
      ).toBe(1);
      expect(imported.err).toEqual([
        expect.stringContaining('the fill was made against input sha256:'),
      ]);
    });
  });

  it('refuses a fill that does not match the annotation schema', async () => {
    await withDataset(async (dataset) => {
      await seed(dataset, { labels: false });
      const pack = join(dataset.path, 'pack.json');
      await writeFile(pack, `${JSON.stringify({ packVersion: 'nope' })}\n`);
      const { io, err } = recorder(REPOSITORY_ROOT);
      expect(await runCli(['import', dataset.path, '--fill', pack], io)).toBe(
        1,
      );
      expect(err[0]).toContain(pack);
    });
  });
});

describe('summary', () => {
  it('prints counts and a digest', async () => {
    await withDataset(async (dataset) => {
      await seed(dataset);
      const { io, out } = recorder(REPOSITORY_ROOT);
      expect(await runCli(['summary', dataset.path], io)).toBe(0);
      expect(out).toEqual(
        expect.arrayContaining([
          'dataset demo',
          'gold 1, excluded 0',
          expect.stringMatching(/^digest sha256:/u),
        ]),
      );
    });
  });

  it('fails when the dataset is not usable', async () => {
    await withDataset(async (dataset) => {
      await dataset.write('cases/case-a.json', reviewCase());
      const { io } = recorder(REPOSITORY_ROOT);
      expect(await runCli(['summary', dataset.path], io)).toBe(1);
    });
  });
});
