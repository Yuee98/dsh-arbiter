import {
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withWorkflowArea } from '../evals/helpers/workflow-run.js';
import { reportRun } from '../../evals/src/report/command.js';
import { observeRun } from '../../evals/src/metrics/observe.js';
import { buildReport, defaultSettings } from '../../evals/src/metrics/index.js';
import { reportGroups } from '../../evals/src/report/details.js';

describe(
  'complete grouped archive output boundaries',
  { timeout: 30_000 },
  () => {
    it('writes resolvable group links with a spaced prefix and every planned row in stable order', async () => {
      await withWorkflowArea(async (area) => {
        await area.write();
        const prefix = join(area.directory, 'archive space', 'full report');
        expect(
          await area.cli(['run', area.planPath, '--report', '--out', prefix]),
        ).toBe(0);
        const markdown = await readFile(`${prefix}.md`, 'utf8');
        const links = [...markdown.matchAll(/\]\(([^)]+)\)/gu)].map(
          (match) => match[1],
        );
        expect(links).toHaveLength(1);
        const target = links[0];
        if (target === undefined) throw new Error('missing group link');
        const actual = await readFile(
          join(area.directory, 'archive space', decodeURIComponent(target)),
          'utf8',
        );
        expect(actual).toContain('format-clean-main~decision-a~decision~r1');
        expect(actual).toContain('format-build-main~decision-a~decision~r1');
        expect(actual.indexOf('format-build-main~')).toBeLessThan(
          actual.indexOf('format-clean-main~'),
        );
        expect(await readdir(`${prefix}.details`)).toHaveLength(1);
      });
    });
    it('retains the frozen workflow split and every planned identity when the source disappears', async () => {
      await withWorkflowArea(async (area) => {
        await area.write();
        expect(await area.cli(['run', area.planPath])).toBe(0);
        const indexPath = join(area.runDirectory, 'index.json');
        const before = await readFile(indexPath, 'utf8');
        await rm(area.sourcePath);
        const prefix = join(area.directory, 'missing-source');
        expect(
          await area.cli(['report', area.runDirectory, '--out', prefix]),
        ).toBe(0);
        const markdown = await readFile(`${prefix}.md`, 'utf8');
        expect(markdown).toContain('[dev/f01]');
        expect(markdown).not.toContain('[unknown/f01]');
        const files = await readdir(`${prefix}.details`);
        expect(files).toEqual([
          `${encodeURIComponent(JSON.stringify(['dev', 'f01']))}.md`,
        ]);
        const detail = await readFile(
          join(`${prefix}.details`, files[0] ?? ''),
          'utf8',
        );
        expect(detail).toContain('分组明细 dev/f01');
        expect(detail).toContain('format-clean-main~decision-a~decision~r1');
        expect(detail).toContain('format-build-main~decision-a~decision~r1');
        expect(await readFile(indexPath, 'utf8')).toBe(before);
      });
    });
    it('refuses a detail-directory alias into source evidence before writing any main output', async () => {
      await withWorkflowArea(async (area) => {
        await area.write();
        const source = await readFile(area.sourcePath, 'utf8');
        const prefix = join(area.directory, 'archive', 'report');
        await mkdir(join(area.directory, 'archive'));
        await symlink(join(area.datasetPath, 'dev/f01'), `${prefix}.details`);
        expect(
          await area.cli([
            'run',
            area.planPath,
            '--report',
            '--out',
            prefix,
            '--force',
          ]),
        ).toBe(1);
        await expect(readFile(`${prefix}.json`)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(await readFile(area.sourcePath, 'utf8')).toBe(source);
      });
    });
    it('checks existing group details before the first main file and reports partial IO failure truthfully', async () => {
      await withWorkflowArea(async (area) => {
        await area.write();
        expect(await area.cli(['run', area.planPath])).toBe(0);
        const read = await observeRun({
          directory: area.runDirectory,
          root: area.root,
          dataset: { kind: 'recorded' },
        });
        if (!read.ok) throw new Error('missing observation');
        const report = buildReport({
          observation: read.observation,
          settings: defaultSettings(area.root),
        });
        const group = reportGroups(report)[0];
        if (group === undefined) throw new Error('missing group');
        const prefix = join(area.directory, 'report');
        await mkdir(`${prefix}.details`);
        const detail = join(`${prefix}.details`, group.file);
        await writeFile(detail, 'existing detail');
        const log: string[] = [];
        const io = {
          root: area.root,
          out: (line: string) => log.push(line),
          err: (line: string) => log.push(line),
        };
        const options = {
          directory: area.runDirectory,
          dataset: null,
          output: prefix,
          mode: 'ask',
          channel: 'available',
          force: false,
        };
        expect(await reportRun(io, options)).toBe(1);
        expect(await readFile(detail, 'utf8')).toBe('existing detail');
        await expect(readFile(`${prefix}.json`)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        const before = await readFile(
          join(area.runDirectory, 'index.json'),
          'utf8',
        );
        await mkdir(`${prefix}.html`);
        log.length = 0;
        expect(await reportRun(io, { ...options, force: true })).toBe(1);
        expect(log.some((line) => line.includes('generation complete'))).toBe(
          false,
        );
        expect(log.join('\n')).toContain('output package is incomplete');
        expect(
          await readFile(join(area.runDirectory, 'index.json'), 'utf8'),
        ).toBe(before);
      });
    });
  },
);
