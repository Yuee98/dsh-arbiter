import { randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  RISK_BANDS,
  AUTHORIZATION_BANDS,
} from '../../../src/review-contract/index.js';
import { canonicalJson, digestOf } from '../data/hash.js';
import type { AnnotationContext } from '../data/annotation-types.js';
import type { Split } from '../data/types.js';
import type { WorkflowBatch } from './workflow-types.js';
import type {
  WebPoint,
  WebBootstrap,
  WebMutation,
  WebOpinionReport,
  WebPointSummary,
} from './web-types.js';
import { EMPTY_FORM } from './web-types.js';
import { humanReferenceStatus } from './web-reference-status.js';
import { opinionReport } from './web-opinion-report.js';
import { settleHumanIntent } from './web-settlement.js';
import { buildAnnotationView } from './workflow-view.js';
import type { GroupedDataset } from '../data/group-types.js';
import { workflowState, workflowRecords } from './workflow-store.js';
import { readWorkflowBatch } from './workflow-batch-read.js';
import { importWorkflowHuman } from './workflow-service.js';
import { independentAnswer } from './workflow-validation.js';
import { validEvidence } from './workflow-evidence.js';
import { changedMaterial, formAnswer, humanTarget } from './web-form.js';
import {
  createHumanBatch,
  checkHumanDraftBaseline,
  checkHumanView,
} from './web-human.js';
import {
  atomicPrivateJson,
  loadDraft,
  privateDirectory,
  withDraftClaim,
} from './web-draft-store.js';
import type { DraftPoint, DraftWorkspace } from './web-draft-store.js';

export interface WebScope {
  readonly root: string;
  readonly dataset: string;
  readonly split: Split;
  readonly group?: string;
  readonly context: AnnotationContext;
  readonly mode: 'blind' | 'assisted';
  readonly reviewer?: string;
}
export class AnnotationWriteError extends Error {
  readonly published: boolean | null;
  constructor(published: boolean | null) {
    super(
      published === true
        ? 'LABEL_PUBLISHED_RECOVERY_REQUIRED'
        : published === false
          ? 'LABEL_NOT_PUBLISHED_RETRY_REQUIRED'
          : 'PUBLICATION_UNKNOWN_RETRY_REQUIRED',
    );
    this.published = published;
  }
}
export class AnnotationWorkspace {
  readonly scope: WebScope;
  readonly directory: string;
  readonly path: string;
  readonly identity: string;
  private observed = '';
  private members = '';
  private constructor(scope: WebScope, directory: string, identity: string) {
    this.scope = scope;
    this.directory = directory;
    this.path = join(directory, 'draft.json');
    this.identity = identity;
  }
  static async open(supplied: WebScope): Promise<AnnotationWorkspace> {
    const scope = {
      ...supplied,
      root: resolve(supplied.root),
      dataset: resolve(supplied.dataset),
    };
    if (
      !['dev', 'calibration', 'holdout'].includes(scope.split) ||
      !['blind', 'assisted'].includes(scope.mode)
    )
      throw new Error('invalid annotation scope');
    const identity = digestOf(
      canonicalJson({
        dataset: scope.dataset,
        split: scope.split,
        group: scope.group ?? null,
        context: scope.context,
        mode: scope.mode,
      }),
    );
    const directory = await privateDirectory(scope.root, [
      '.local',
      'evals',
      'workflow-annotation',
      `web-${identity}`,
    ]);
    const workspace = new AnnotationWorkspace(scope, directory, identity);
    await withDraftClaim(directory, async () => {
      const groups =
        scope.group === undefined
          ? (
              await readdir(join(scope.dataset, scope.split), {
                withFileTypes: true,
              })
            )
              .filter(
                (entry) => entry.isDirectory() && entry.name !== 'legacy-v1',
              )
              .map((entry) => entry.name)
              .sort()
          : [scope.group];
      const points: DraftPoint[] = [];
      let workflow = 0;
      for (const group of groups) {
        if (scope.group === undefined) {
          try {
            await lstat(
              join(scope.dataset, scope.split, group, 'workflows.json'),
            );
          } catch (error) {
            if (
              error instanceof Error &&
              'code' in error &&
              error.code === 'ENOENT'
            )
              continue;
            throw error;
          }
        }
        // One fresh source-and-label snapshot; never opens model opinions.
        const source = await workflowState(
          scope.dataset,
          scope.split,
          group,
          true,
        );
        for (const entry of source.groups.flatMap((value) => value.workflows)) {
          workflow += 1;
          for (const [index, point] of entry.document.points.entries())
            points.push({
              token: randomUUID(),
              group,
              rootId: entry.document.rootId,
              pointId: point.pointId,
              viewId: point.primaryViewId,
              workflow,
              position: index + 1,
              batchId: null,
              revision: 0,
              form: { ...EMPTY_FORM, author: scope.reviewer ?? '' },
              status: 'unopened',
              sampled: false,
              exposed: false,
              intent: null,
            });
        }
      }
      const old = await loadDraft(workspace.path);
      const membership = (values: readonly DraftPoint[]) =>
        values.map((p) => [p.group, p.rootId, p.pointId, p.viewId]);
      if (old !== null) {
        if (
          old.scope !== identity ||
          canonicalJson(membership(old.points)) !==
            canonicalJson(membership(points)) ||
          new Set(old.points.map((p) => p.token)).size !== old.points.length
        )
          throw new Error(
            'workspace scope changed; review source membership before starting a new batch',
          );
      } else
        await atomicPrivateJson(workspace.path, {
          version: 'annotation-web-v1',
          scope: identity,
          current: null,
          points,
        });
    });
    const initialized = await loadDraft(workspace.path);
    if (initialized === null) throw new Error('workspace not initialized');
    workspace.observed = canonicalJson(initialized);
    workspace.members = workspace.membership(initialized);
    return workspace;
  }
  private membership(state: DraftWorkspace): string {
    return canonicalJson(
      state.points.map((p) => [
        p.token,
        p.group,
        p.rootId,
        p.pointId,
        p.viewId,
        p.workflow,
        p.position,
      ]),
    );
  }
  private async persist(state: DraftWorkspace): Promise<void> {
    const actual = await loadDraft(this.path);
    if (canonicalJson(actual) !== this.observed)
      throw new Error('conflict: workspace changed externally');
    await atomicPrivateJson(this.path, state);
    this.observed = canonicalJson(state);
  }
  private async load(acceptExternal = false): Promise<DraftWorkspace> {
    const state = await loadDraft(this.path);
    if (state === null || state.scope !== this.identity)
      throw new Error('workspace disappeared or changed');
    if (this.membership(state) !== this.members)
      throw new Error('conflict: workspace membership changed');
    if (!acceptExternal && canonicalJson(state) !== this.observed)
      throw new Error('conflict: workspace changed externally');
    if (acceptExternal) this.observed = canonicalJson(state);
    return state;
  }
  private find(state: DraftWorkspace, token: string): DraftPoint {
    const point = state.points.find((value) => value.token === token);
    if (point === undefined) throw new Error('unknown point');
    return point;
  }
  private batchPath(point: DraftPoint): string {
    if (point.batchId === null || !/^[a-f0-9-]{36}$/u.test(point.batchId))
      throw new Error('point has no prepared baseline');
    return join(this.directory, `${point.batchId}.json`);
  }
  private async batch(point: DraftPoint): Promise<WorkflowBatch> {
    const batch = await readWorkflowBatch(this.batchPath(point));
    if (
      batch.purpose !== 'human' ||
      batch.dataset !== this.scope.dataset ||
      batch.split !== this.scope.split ||
      batch.group !== point.group ||
      batch.points.length !== 1 ||
      batch.points[0]?.questionId !== point.token ||
      batch.points[0].pointId !== point.pointId ||
      batch.points[0].rootId !== point.rootId ||
      canonicalJson(batch.context) !== canonicalJson(this.scope.context)
    )
      throw new Error('private baseline scope conflict');
    return batch;
  }
  async bootstrap(): Promise<WebBootstrap> {
    const state = await this.load();
    const groups = new Map<string, GroupedDataset>();
    for (const group of new Set(state.points.map((point) => point.group)))
      groups.set(
        group,
        await workflowState(this.scope.dataset, this.scope.split, group, true),
      );
    return {
      mode: this.scope.mode,
      current: state.current,
      points: await Promise.all(
        state.points.map((point) =>
          this.summary(point, groups.get(point.group)),
        ),
      ),
      risk: RISK_BANDS,
      authorization: AUTHORIZATION_BANDS,
    };
  }
  private async projection(point: DraftPoint): Promise<WebPoint> {
    const source = await workflowState(
      this.scope.dataset,
      this.scope.split,
      point.group,
      true,
    );
    const base = {
      ...(await this.summary(point, source)),
      revision: point.revision,
      form: point.form,
      exposed: point.exposed,
      publicationPending: point.intent !== null,
      decisionDate: point.intent?.decisions[0]?.target.decidedAt ?? null,
      viewToken: point.batchId === null ? null : digestOf(point.batchId),
    };
    if (point.batchId === null)
      return {
        ...base,
        preparation: 'preparation-failed',
        request: null,
        error: 'MATERIAL_PREPARATION_FAILED',
        hasPredecessor: false,
        changedLines: [],
      };
    const batch = await this.batch(point);
    const ownDecision = batch.labels.find(
      (label) =>
        label.referenceId === batch.points[0]?.humanReferenceId &&
        label.batchId === batch.batchId &&
        label.source === 'human',
    );
    base.decisionDate ??= ownDecision?.target.decidedAt ?? null;
    const current = batch.points[0];
    if (current === undefined) throw new Error('missing point baseline');
    try {
      await checkHumanView(batch, source);
    } catch {
      return {
        ...base,
        preparation: 'preparation-failed',
        request: null,
        error: 'MATERIAL_CHANGED_REVIEW_REQUIRED',
        viewToken: null,
        status: 'preparation-failed',
        hasPredecessor: false,
        changedLines: [],
      };
    }
    const document = source.groups
      .flatMap((g) => g.workflows)
      .find((entry) => entry.document.rootId === point.rootId)?.document;
    const previousId = document?.points.find(
      (p) => p.pointId === point.pointId,
    )?.predecessorPointId;
    let previous: unknown = undefined;
    if (previousId !== undefined) {
      try {
        previous = (
          await buildAnnotationView(
            source,
            point.rootId,
            previousId,
            this.scope.context,
          )
        ).request;
      } catch {
        /* No raw or failed predecessor is a usable comparison. */
      }
    }
    return {
      ...base,
      preparation: 'ready',
      request: current.request,
      error: null,
      hasPredecessor: previous !== undefined,
      changedLines:
        previous === undefined
          ? []
          : changedMaterial(current.request, previous),
    };
  }
  async point(token: string, refresh = false): Promise<WebPoint> {
    return withDraftClaim(this.directory, async () => {
      const state = await this.load(refresh),
        point = this.find(state, token);
      if (point.batchId === null) {
        try {
          const batch = await createHumanBatch(
            this.scope.dataset,
            this.scope.split,
            point,
            this.scope.context,
          );
          await atomicPrivateJson(
            join(this.directory, `${batch.batchId}.json`),
            batch,
          );
          point.batchId = batch.batchId;
          point.status = 'draft';
        } catch {
          point.status = 'preparation-failed';
        }
      }
      state.current = token;
      const projected = await this.projection(point);
      point.status = projected.status;
      await this.persist(state);
      return projected;
    });
  }
  async rebase(token: string, revision: number): Promise<WebPoint> {
    return withDraftClaim(this.directory, async () => {
      const state = await this.load(),
        point = this.find(state, token);
      if (revision !== point.revision)
        throw new Error('conflict: draft changed externally');
      if (point.intent !== null)
        throw new Error(
          'confirmation pending: settle the saved confirmation before rebasing',
        );
      const batch = await createHumanBatch(
        this.scope.dataset,
        this.scope.split,
        point,
        this.scope.context,
      );
      point.batchId = batch.batchId;
      point.revision += 1;
      point.status = 'draft';
      point.intent = null;
      await atomicPrivateJson(this.batchPath(point), batch);
      await this.persist(state);
      return this.projection(point);
    });
  }
  async save(value: WebMutation): Promise<WebPoint> {
    return withDraftClaim(this.directory, async () => {
      const state = await this.load(),
        point = this.find(state, value.token);
      if (point.revision !== value.revision)
        throw new Error('conflict: draft changed externally');
      if (point.intent !== null)
        throw new Error(
          'confirmation pending: retry confirmation before editing',
        );
      await checkHumanDraftBaseline(await this.batch(point));
      point.form = value.form;
      point.sampled = value.sampled;
      point.revision += 1;
      point.status = 'draft';
      state.current = point.token;
      await this.persist(state);
      return this.projection(point);
    });
  }
  async confirm(value: WebMutation): Promise<WebPoint> {
    return withDraftClaim(this.directory, async () => {
      const state = await this.load(),
        point = this.find(state, value.token);
      if (point.revision !== value.revision)
        throw new Error('conflict: draft changed externally');
      const batch = await this.batch(point);
      await checkHumanView(batch);
      if (value.form.noScores === true && value.form.pairs.trim() !== '')
        throw new Error('explicit no-score decision cannot retain score pairs');
      const answer = independentAnswer(formAnswer(value.form));
      if (value.form.author.trim() === '' || answer.rationale.trim() === '')
        throw new Error('author and rationale are required');
      if (
        value.form.state === 'confirmed' &&
        (answer.behaviourReference === null ||
          (answer.pairs === null && value.form.noScores !== true) ||
          (value.form.noScores !== true &&
            !validEvidence(answer.evidence, batch.points[0]?.request, true)) ||
          (answer.evidence.length > 0 &&
            !validEvidence(answer.evidence, batch.points[0]?.request, true)))
      )
        throw new Error(
          'confirmation requires complete pairs, independent behaviour and exact visible evidence',
        );
      if (
        point.intent !== null &&
        canonicalJson(value.form) !== canonicalJson(point.form)
      )
        throw new Error('confirmation pending: retry the original form');
      if (point.intent === null) {
        await checkHumanDraftBaseline(batch);
        point.form = value.form;
        point.sampled = value.sampled;
        point.intent = {
          batchId: batch.batchId,
          decisions: [
            {
              questionId: point.token,
              state: value.form.state,
              target: humanTarget(
                answer,
                value.form.author,
                value.form.state,
                new Date().toISOString().slice(0, 10),
              ),
            },
          ],
        };
        await importWorkflowHuman({
          dataset: this.scope.dataset,
          baseline: this.batchPath(point),
          fill: point.intent,
          write: false,
        });
        await this.persist(state);
      }
      // The durable intent makes retries use the same date/target after any partial write.
      const options = {
        dataset: this.scope.dataset,
        baseline: this.batchPath(point),
        fill: point.intent,
      };
      let published = false;
      try {
        await importWorkflowHuman({ ...options, write: true });
        published = true;
        point.status = value.form.state;
        point.revision += 1;
        point.intent = null;
        await this.persist(state);
      } catch {
        if (published) throw new AnnotationWriteError(true);
        try {
          const preview = await importWorkflowHuman({
            ...options,
            write: false,
          });
          const actual = workflowRecords(
            await workflowState(
              this.scope.dataset,
              this.scope.split,
              point.group,
              true,
            ),
          );
          const reference = batch.points[0]?.humanReferenceId;
          const desired = preview.labels.find(
            (label) => label.referenceId === reference,
          );
          throw new AnnotationWriteError(
            desired !== undefined &&
              canonicalJson(
                actual.labels.find(
                  (label) => label.referenceId === reference,
                ) ?? null,
              ) === canonicalJson(desired),
          );
        } catch (error) {
          if (error instanceof AnnotationWriteError) throw error;
          throw new AnnotationWriteError(null);
        }
      }
      return this.projection(point);
    });
  }
  async opinions(token: string): Promise<WebOpinionReport> {
    if (this.scope.mode !== 'assisted')
      throw new Error('blind mode does not load model opinions');
    return withDraftClaim(this.directory, async () => {
      const state = await this.load(),
        point = this.find(state, token),
        batch = await this.batch(point);
      await checkHumanView(batch);
      point.exposed = true;
      await this.persist(state);
      const records = workflowRecords(
        await workflowState(this.scope.dataset, this.scope.split, point.group),
      );
      return opinionReport(batch, records.opinions);
    });
  }
  async settle(token: string, revision: number): Promise<WebPoint> {
    return withDraftClaim(this.directory, async () => {
      const state = await this.load(),
        point = this.find(state, token);
      if (point.revision !== revision)
        throw new Error('conflict: draft changed externally');
      if (point.intent === null) throw new Error('no pending confirmation');
      const batch = await this.batch(point);
      const result = await settleHumanIntent(
        this.batchPath(point),
        batch,
        point.intent,
      ).catch(() => {
        throw new AnnotationWriteError(null);
      });
      if (!result.checkpointed) throw new AnnotationWriteError(true);
      point.intent = null;
      point.status = result.published ? result.state : 'draft';
      point.revision += 1;
      try {
        await this.persist(state);
      } catch {
        throw new AnnotationWriteError(result.published);
      }
      return this.projection(point);
    });
  }
  private async summary(
    point: DraftPoint,
    supplied?: GroupedDataset,
  ): Promise<WebPointSummary> {
    const source =
      supplied ??
      (await workflowState(
        this.scope.dataset,
        this.scope.split,
        point.group,
        true,
      ));
    const records = workflowRecords(source);
    return {
      token: point.token,
      workflow: point.workflow,
      position: point.position,
      status: point.status,
      sampled: point.sampled,
      referenceStatus: await humanReferenceStatus(
        source,
        records.labels,
        point,
        this.scope.context,
      ),
    };
  }
}
