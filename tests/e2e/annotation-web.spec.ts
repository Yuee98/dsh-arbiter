/** Reproducible synthetic CLI/Chromium proof; no model call or real adjudication. */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

test('local annotation CLI restores drafts and confirms only the reviewed point', async ({
  page,
  browser,
}) => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const temporary = await mkdtemp(
    join(tmpdir(), 'arbiter-annotation-browser-'),
  );
  process.env['DSH_HOME'] = join(temporary, 'dsh-home');
  const { collectionOf, workflow } =
    await import('../evals/fixtures/workflow.js');
  const { copy } = await import('../../evals/src/annotation/web-copy.js');
  const { canonicalJson, digestOf } =
    await import('../../evals/src/data/hash.js');
  const { DEFAULT_ANNOTATION_CONTEXT } =
    await import('../../evals/src/annotation/workflow-view.js');
  const dataset = join(temporary, 'data');
  await mkdir(join(dataset, 'dev/f01'), { recursive: true });
  await writeFile(
    join(dataset, 'dev/f01/workflows.json'),
    JSON.stringify(collectionOf(workflow())),
  );
  const identity = digestOf(
    canonicalJson({
      dataset,
      split: 'dev',
      group: 'f01',
      mode: 'blind',
      context: DEFAULT_ANNOTATION_CONTEXT,
    }),
  );
  const privateDirectory = join(
    root,
    '.local/evals/workflow-annotation',
    `web-${identity}`,
  );
  const artifacts = join(root, '.local/cw-128');
  await mkdir(artifacts, { recursive: true });
  async function launch(): Promise<{ child: ChildProcess; url: string }> {
    const child = spawn(
      process.execPath,
      [
        join(root, 'evals/src/cli.ts'),
        'annotate',
        dataset,
        '--group',
        'f01',
        '--reviewer',
        'synthetic-browser',
      ],
      { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return new Promise((resolve, reject) => {
      let text = '',
        errors = '';
      const failed = (error: Error) => {
        clearTimeout(timer);
        child.kill('SIGTERM');
        reject(error);
      };
      const timer = setTimeout(() => {
        failed(new Error(`annotation CLI startup timeout: ${errors}`));
      }, 30_000);
      child.once('error', failed);
      child.stderr.on('data', (chunk: Buffer) => {
        errors += chunk.toString();
      });
      child.stdout.on('data', (chunk: Buffer) => {
        text += chunk.toString();
        const url = /http:\/\/127\.0\.0\.1:\d+\/#([a-f0-9]{64})/u.exec(
          text,
        )?.[0];
        if (url !== undefined) {
          clearTimeout(timer);
          resolve({ child, url });
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (!text.includes('http://127.0.0.1:'))
          reject(new Error(`annotation CLI exited ${String(code)}: ${errors}`));
      });
    });
  }
  async function stop(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('annotation CLI did not close on SIGTERM'));
          }, 10_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  let service: Awaited<ReturnType<typeof launch>> | null = null;
  try {
    await page.setViewportSize({ width: 1600, height: 1080 });
    const opinionRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/opinions'))
        opinionRequests.push(request.url());
    });
    service = await launch();
    await page.goto(service.url);
    await page
      .getByLabel(copy.rationale)
      .fill('Synthetic browser draft, not a real human adjudication');
    await expect(page.getByRole('status')).toHaveText(copy.saved);
    await page.reload();
    await expect(page.getByLabel(copy.rationale)).toHaveValue(
      'Synthetic browser draft, not a real human adjudication',
    );
    await stop(service.child);
    service = await launch();
    await page.goto(service.url);
    await expect(page.getByLabel(copy.rationale)).toHaveValue(
      'Synthetic browser draft, not a real human adjudication',
    );
    await page.getByLabel(copy.pairs).fill('3,10\n4,9');
    await page.getByLabel(copy.behaviour).selectOption('deny');
    await page
      .getByLabel(copy.evidence)
      .fill('可以清理生成目录 build/；保留 assets/。');
    await page.getByRole('button', { name: copy.confirm, exact: true }).click();
    await expect(page.getByRole('status')).toHaveText(copy.confirmed);
    expect(opinionRequests).toEqual([]);
    await expect(page.getByText(copy.blind)).toBeVisible();
    expect(await page.locator('body').innerText()).not.toMatch(
      /AUTHOR_SENTINEL|FUTURE_FAILURE_SENTINEL/u,
    );
    const labels: unknown = JSON.parse(
      await readFile(join(dataset, 'dev/f01/labels.json'), 'utf8'),
    );
    expect(labels).toMatchObject({
      records: [
        {
          source: 'human',
          humanConfirmed: true,
          target: {
            allowedPairs: [
              [3, 10],
              [4, 9],
            ],
            behaviourReference: 'deny',
          },
        },
      ],
    });
    const { compileCheckers } = await import('../../evals/src/data/schemas.js');
    const parsed = (await compileCheckers()).groupedLabels(labels);
    if (!parsed.ok) throw new Error(parsed.problems.join('; '));
    const decisionDate = parsed.document.records[0]?.target.decidedAt;
    if (typeof decisionDate !== 'string')
      throw new Error('confirmed fixture date missing');
    await page.clock.setFixedTime(new Date('2099-07-01T12:00:00Z'));
    await page.reload();
    await expect(page.getByLabel(copy.rationale)).toHaveValue(
      'Synthetic browser draft, not a real human adjudication',
    );
    await expect(
      page.getByText(`${copy.date} ${decisionDate}`, { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: join(artifacts, 'browser.png') });
    await page
      .getByRole('button', { name: copy.confirmNext, exact: true })
      .click();
    await expect(page.getByLabel(copy.rationale)).toHaveValue('');
    const afterNext: unknown = JSON.parse(
      await readFile(join(dataset, 'dev/f01/labels.json'), 'utf8'),
    );
    const checkedAfterNext = (await compileCheckers()).groupedLabels(afterNext);
    if (!checkedAfterNext.ok)
      throw new Error(checkedAfterNext.problems.join('; '));
    expect(checkedAfterNext.document.records).toHaveLength(1);
    await writeFile(
      join(artifacts, 'browser-result.json'),
      JSON.stringify(
        {
          passed: true,
          syntheticOnly: true,
          commands: [
            'pnpm exec playwright test tests/e2e/annotation-web.spec.ts',
            'node evals/src/cli.ts annotate <temporary-dataset> --group f01 --reviewer synthetic-browser',
          ],
          steps: [
            'real CLI + esbuild bundle',
            'edit and autosave',
            'refresh restores draft',
            'SIGTERM closes server',
            'CLI restart restores draft',
            'explicit single-point confirmation',
            'labels readback retains full pairs and independent behaviour',
            'no opinion requests or future/author sentinels',
            'persisted decision date survives changed browser clock and reload',
            'confirm-and-next navigates after current success without confirming the next point',
          ],
          browserVersion: browser.version(),
          screenshot: join(artifacts, 'browser.png'),
          checkedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
    );
    process.stdout.write(
      'PASS: real annotation CLI, Chromium, autosave/refresh/restart/confirmation and file readback\n',
    );
  } finally {
    if (service !== null) await stop(service.child);
    await rm(privateDirectory, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
});
