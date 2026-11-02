/** The saved runner and rebuilding report deliberately use different process-local marker keys. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CREDENTIAL_MARKER_SOURCE } from '../../src/reviewer/credential-markers.js';
import {
  loadWorkflowSources,
  sourceMaterial,
} from '../../evals/src/run/source.js';
import { readRun } from '../../evals/src/run/artifact.js';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';
import { withWorkflowArea } from '../evals/helpers/workflow-run.js';
import {
  dualProtocolPlan,
  frozenWorkflowReferences,
  workflowReport,
} from '../evals/helpers/report-workflow.js';
import { comparableAnnotationRequest } from '../../evals/src/annotation/workflow-binding.js';

const execute = promisify(execFile);
describe('workflow report credential material proof', () => {
  it('qualifies actual cross-process requests, while preserving marker kind and equality relationships', async () => {
    await withWorkflowArea(async (area) => {
      const plan = dualProtocolPlan(area.plan);
      const message = area.source.events[0];
      if (message?.kind !== 'message')
        throw new Error('missing synthetic message');
      const document = {
        ...area.source,
        events: [
          {
            ...message,
            content: `${message.content}\nAuthorization: Bearer synthetic-alpha-secret\nAuthorization: Bearer synthetic-beta-secret\nAuthorization: Bearer synthetic-alpha-secret`,
          },
          ...area.source.events.slice(1),
        ],
      };
      await writeFile(
        area.sourcePath,
        JSON.stringify({ schemaVersion: 'grouped-v1', records: [document] }),
      );
      await area.write(plan);
      const references = await frozenWorkflowReferences(area.directory, plan);
      await execute(
        process.execPath,
        [join(area.root, 'evals/src/cli.ts'), 'run', area.planPath],
        { cwd: area.root, env: process.env },
      );
      const read = await readRun(
        area.runDirectory,
        await compileRunCheckers(),
        { allowWorkflow: true },
      );
      if (!read.ok)
        throw new Error(
          read.problems.map((problem) => problem.message).join('; '),
        );
      const first = read.artifact.records[0];
      const source = (
        await loadWorkflowSources(area.root, read.artifact.plan)
      ).cases.find((entry) => entry.caseId === first?.case.caseId);
      if (
        first?.material === null ||
        first === undefined ||
        source === undefined
      )
        throw new Error('missing actual material');
      const rebuilt = await sourceMaterial(
        source,
        first.target.protocol,
        read.artifact.plan,
      );
      expect(first.material.promptFingerprint).not.toBe(
        rebuilt.material.promptFingerprint,
      );
      const report = await workflowReport(
        area.root,
        area.runDirectory,
        references,
      );
      expect(report.quality?.references.cellsBySource).toEqual({ human: 8 });
      expect(
        report.examples.every(
          (cell) => cell.evaluationReference?.binding?.credentials === true,
        ),
      ).toBe(true);
      const initial = first.attempts[0];
      if (initial === undefined) throw new Error('missing actual attempt');
      const text = JSON.stringify(initial.request);
      const markers = [
        ...new Set(text.match(new RegExp(CREDENTIAL_MARKER_SOURCE, 'gu'))),
      ];
      expect(markers).toHaveLength(2);
      expect(text).not.toContain('synthetic-alpha-secret');
      const [alpha, beta] = markers;
      if (alpha === undefined || beta === undefined)
        throw new Error('missing markers');
      const path = join(area.runDirectory, 'records', `${first.cellId}.json`);
      const original = await readFile(path, 'utf8');
      const renamed = text.replace(/[a-f0-9]{64}/gu, (value) =>
        value.split('').reverse().join(''),
      );
      expect(
        comparableAnnotationRequest(JSON.parse(renamed) as unknown).text,
      ).toBe(comparableAnnotationRequest(initial.request).text);
      const collapsed: unknown = JSON.parse(text.replaceAll(beta, alpha));
      await writeFile(
        path,
        JSON.stringify({
          ...first,
          attempts: [
            { ...initial, request: collapsed },
            ...first.attempts.slice(1),
          ],
        }),
      );
      const wrong = await workflowReport(
        area.root,
        area.runDirectory,
        references,
      );
      expect(wrong.quality?.references.cellsBySource).toEqual({
        unresolved: 1,
        human: 7,
      });
      expect(
        wrong.examples.find((cell) => cell.cellId === first.cellId)
          ?.evaluationReference?.reasons,
      ).toContain('record-request-drift');
      const kindChanged: unknown = JSON.parse(
        text
          .replaceAll(':credential:', ':password:')
          .replaceAll(':token:', ':password:'),
      );
      expect(comparableAnnotationRequest(kindChanged).text).not.toBe(
        comparableAnnotationRequest(initial.request).text,
      );
      await writeFile(path, original);
    });
  });
});
