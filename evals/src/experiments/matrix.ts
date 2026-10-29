/**
 * Expanding an experiment into the cells it would send, and measuring them.
 *
 * A dry run has to answer one question honestly: what will this experiment actually
 * submit? That is not `cases x candidates` — it is one rendered request per (case,
 * candidate, protocol, repeat), each with its own measured input estimate, because the
 * renders differ (that is the whole experiment). So each cell is rendered by the
 * production renderer for that candidate's package and measured with the same estimate
 * the runner charges.
 *
 * This is possible offline because rendering is pure: it reads a snapshot built from a
 * committed case and produces text. No model is called, no network is touched, and no
 * run directory is written.
 *
 * The cache workload (`cache.ts`) expands through the same three seams exported here, so
 * a matrix cell and a cache request cannot be measured by two different rules.
 */

import { estimateTokenCount } from 'tokenx';

import type { ReviewCase } from '../data/types.js';
import { digestOf } from '../data/hash.js';

import { renderMaterial } from '../../../src/reviewer/material.js';
import {
  renderVariantChatRequest,
  renderVariantDecisionRequest,
} from '../../../src/reviewer/prompt.js';
import type { ProbeReading } from '../../../src/reviewer/probe.js';
import type { ReviewVariant } from '../../../src/reviewer/variant.js';
import type { ReviewSnapshot } from '../../../src/types.js';

import { caseMaterial } from '../run/material.js';
import type { RunProtocol } from '../run/types.js';

import type { ResolvedCandidate } from './inspect.js';

/**
 * The action boundary in each layout, as the layout itself spells it.
 *
 * The cache workload cuts a rendered request at this boundary, and both markers are the
 * layout's own text rather than something this module adds: the production layout emits
 * `PENDING_ACTION` as a block label, and the compact layout emits it as a member name.
 * A second, experiment-only marker would be a third layout to keep in step.
 */
const ACTION_MARKERS = ['\nPENDING_ACTION\n', '\n  "pending_action":'];

/** One expanded cell, with the request it would send measured. */
export interface ExperimentCell {
  readonly cellId: string;
  readonly caseId: string;
  readonly candidateId: string;
  readonly variantId: string;
  readonly protocol: RunProtocol;
  readonly repeat: number;
  /** The renderer's own estimate for this exact package and protocol. */
  readonly estimatedInputTokens: number;
  /**
   * The fingerprint of the exact request this cell would submit.
   *
   * Two cells share a fingerprint exactly when they would send the same bytes, which is
   * what lets a dry run prove a variant actually differed instead of assuming it did.
   */
  readonly promptFingerprint: string;
  /**
   * Whether the production budget marked this request as over its own input bound.
   *
   * A cell whose snapshot carries `OVER_BUDGET` is one the run could not assemble within
   * the declared per-request ceiling. It is measured and reported rather than counted as
   * sendable, because charging it would budget a request the runner must refuse.
   */
  readonly overBudget: boolean;
}

/** One candidate's share of the matrix. */
export interface CandidateExpansion {
  readonly candidate: ResolvedCandidate;
  readonly cells: readonly ExperimentCell[];
  /** Measured total of every cell this candidate would send, repeats included. */
  readonly estimatedInputTokens: number;
  /** Distinct request fingerprints: how many *different* prompts this candidate sends. */
  readonly distinctRequests: number;
}

/** The whole matrix, expanded and measured. */
export interface ExpandedMatrix {
  readonly candidates: readonly CandidateExpansion[];
  readonly cells: number;
  readonly estimatedInputTokens: number;
  /** Cells the production budget refused, which no run could send. */
  readonly overBudgetCells: number;
}

/**
 * The material one (case, protocol, bound) yields, built once per expansion.
 *
 * `caseMaterial` runs the production trim, which renders both payloads until the budget
 * block is stable — by far the most expensive step, and one that depends only on (case,
 * protocol, limit). Every candidate and every repeat of a case shares it. Caching it is
 * what keeps a full-matrix dry run inside one test's time limit without changing a
 * measured number: the value is the same one a fresh call produces.
 */
export type MaterialCache = Map<string, ReturnType<typeof caseMaterial>>;

/** One case's production material, from the cache when this expansion already built it. */
export function materialFor(
  cache: MaterialCache,
  parts: {
    readonly caseEntry: ReviewCase;
    readonly protocol: RunProtocol;
    readonly maxInputTokens: number;
  },
): ReturnType<typeof caseMaterial> {
  const key = `${parts.caseEntry.caseId}\u0000${parts.protocol}\u0000${String(parts.maxInputTokens)}`;
  const found = cache.get(key);
  if (found !== undefined) return found;
  const built = caseMaterial(parts.caseEntry, parts.protocol, {
    maxInputTokens: parts.maxInputTokens,
  });
  cache.set(key, built);
  return built;
}

/**
 * A rendered request under one variant, with the production budget's verdict on it.
 *
 * Both variants are reproduced as a discriminated union rather than widened to `unknown`:
 * a chat request and a decision request have different payload fields, and a reader that
 * had to assert which one it held could read the wrong one.
 */
export type RenderedVariant =
  | {
      readonly protocol: 'chat';
      readonly request: ReturnType<typeof renderVariantChatRequest>;
      readonly overBudget: boolean;
    }
  | {
      readonly protocol: 'decision';
      readonly request: ReturnType<typeof renderVariantDecisionRequest>;
      readonly overBudget: boolean;
    };

/**
 * Render one snapshot under one variant.
 *
 * The production renderer is injected by name rather than re-implemented, so a
 * full-layout candidate submits the production bytes rather than a copy that happens to
 * look the same.
 */
export function renderFor(parts: {
  readonly snapshot: ReviewSnapshot;
  readonly variant: ReviewVariant;
  readonly protocol: RunProtocol;
}): RenderedVariant {
  const overBudget =
    parts.snapshot.budget.truncatedSegments.includes('OVER_BUDGET');
  return parts.protocol === 'chat'
    ? {
        protocol: 'chat',
        request: renderVariantChatRequest(
          parts.snapshot,
          parts.variant,
          renderMaterial,
        ),
        overBudget,
      }
    : {
        protocol: 'decision',
        request: renderVariantDecisionRequest(
          parts.snapshot,
          parts.variant,
          renderMaterial,
        ),
        overBudget,
      };
}

/** The submitted material text of a rendered request. */
export function materialTextOf(rendered: RenderedVariant): string {
  return rendered.protocol === 'chat'
    ? rendered.request.user
    : rendered.request.state;
}

/**
 * Split submitted material into the stable prefix and the action region.
 *
 * The cut is the production layout's own block boundary. A layout that does not submit
 * the production block order has no locatable boundary and yields `null`, which the cache
 * workload reports rather than guessing: cutting at an offset would compare two different
 * things and call the comparison a prefix.
 */
export function splitAtAction(
  material: string,
): { readonly prefix: string; readonly action: string } | null {
  // The last occurrence: the action block is the final region before the completeness
  // report, and `PENDING_ACTION` cannot appear as evidence text ahead of it without the
  // layout having already emitted its block label.
  const indices = ACTION_MARKERS.map((marker) =>
    material.lastIndexOf(marker),
  ).filter((index) => index >= 0);
  const index = Math.max(...indices);
  if (!Number.isFinite(index) || index < 0) return null;
  const start = index + 1;
  return { prefix: material.slice(0, start), action: material.slice(start) };
}

/** One rendered, measured request: what a cell or a cache request records. */
export interface MeasuredRequest {
  readonly request: RenderedVariant['request'];
  readonly material: string;
  readonly estimatedInputTokens: number;
  readonly promptFingerprint: string;
  readonly overBudget: boolean;
}

/** Render and measure one snapshot under one variant and protocol. */
export function measuredOf(
  parts: { readonly snapshot: ReviewSnapshot },
  rest: {
    readonly variant: ReviewVariant;
    readonly protocol: RunProtocol;
  },
): MeasuredRequest {
  const rendered = renderFor({
    snapshot: parts.snapshot,
    variant: rest.variant,
    protocol: rest.protocol,
  });
  return {
    request: rendered.request,
    estimatedInputTokens: rendered.request.estimatedInputTokens,
    promptFingerprint: digestOf({
      protocol: rest.protocol,
      request: rendered.request,
    }),
    material: materialTextOf(rendered),
    overBudget: rendered.overBudget,
  };
}

/** The cell id of one (case, candidate, protocol, repeat). */
export function experimentCellId(parts: {
  readonly caseId: string;
  readonly candidateId: string;
  readonly protocol: RunProtocol;
  readonly repeat: number;
}): string {
  return [
    parts.caseId,
    parts.candidateId,
    parts.protocol,
    `r${String(parts.repeat)}`,
  ].join('~');
}

/**
 * Render one cell without sending it.
 *
 * `caseMaterial` is the production composition (case → snapshot → trim), so the
 * measurement is of the material production would actually assemble; the variant render
 * is then applied on top, which is the only step the experiment changes.
 */
export function measureCell(parts: {
  readonly caseEntry: ReviewCase;
  readonly candidate: ResolvedCandidate;
  readonly protocol: RunProtocol;
  readonly repeat: number;
  readonly maxInputTokens: number;
  readonly materials?: MaterialCache;
}): ExperimentCell {
  const material = materialFor(
    parts.materials ?? new Map<string, ReturnType<typeof caseMaterial>>(),
    {
      caseEntry: parts.caseEntry,
      protocol: parts.protocol,
      maxInputTokens: parts.maxInputTokens,
    },
  );
  const measured = measuredOf(
    { snapshot: material.snapshot },
    { variant: parts.candidate.variant, protocol: parts.protocol },
  );
  return {
    cellId: experimentCellId({
      caseId: parts.caseEntry.caseId,
      candidateId: parts.candidate.candidateId,
      protocol: parts.protocol,
      repeat: parts.repeat,
    }),
    caseId: parts.caseEntry.caseId,
    candidateId: parts.candidate.candidateId,
    variantId: parts.candidate.variant.variantId,
    protocol: parts.protocol,
    repeat: parts.repeat,
    estimatedInputTokens: measured.estimatedInputTokens,
    promptFingerprint: measured.promptFingerprint,
    overBudget: measured.overBudget,
  };
}

/** One candidate's cells, all cases, protocols and repeats included. */
function expandCandidate(parts: {
  readonly candidate: ResolvedCandidate;
  readonly cases: readonly ReviewCase[];
  readonly protocols: readonly RunProtocol[];
  readonly repeats: number;
  readonly maxInputTokens: number;
  readonly materials: MaterialCache;
}): CandidateExpansion {
  const cells: ExperimentCell[] = [];
  for (const caseEntry of parts.cases) {
    for (const protocol of parts.protocols) {
      for (let repeat = 1; repeat <= parts.repeats; repeat += 1) {
        cells.push(
          measureCell({
            caseEntry,
            candidate: parts.candidate,
            protocol,
            repeat,
            maxInputTokens: parts.maxInputTokens,
            materials: parts.materials,
          }),
        );
      }
    }
  }
  return {
    candidate: parts.candidate,
    cells,
    estimatedInputTokens: cells.reduce(
      (sum, cell) => sum + cell.estimatedInputTokens,
      0,
    ),
    distinctRequests: new Set(cells.map((cell) => cell.promptFingerprint)).size,
  };
}

/** Expand the whole matrix, measuring every cell. */
export function expandMatrix(parts: {
  readonly candidates: readonly ResolvedCandidate[];
  readonly cases: readonly ReviewCase[];
  readonly protocols: readonly RunProtocol[];
  readonly repeats: number;
  readonly maxInputTokens: number;
}): ExpandedMatrix {
  // One material cache for the whole expansion: a case and protocol are composed once,
  // whatever the number of candidates and repeats measuring them.
  const materials: MaterialCache = new Map();
  const candidates = parts.candidates.map((candidate) =>
    expandCandidate({
      candidate,
      cases: parts.cases,
      protocols: parts.protocols,
      repeats: parts.repeats,
      maxInputTokens: parts.maxInputTokens,
      materials,
    }),
  );
  const cells = candidates.flatMap((entry) => entry.cells);
  return {
    candidates,
    cells: cells.length,
    estimatedInputTokens: candidates.reduce(
      (sum, entry) => sum + entry.estimatedInputTokens,
      0,
    ),
    overBudgetCells: cells.filter((cell) => cell.overBudget).length,
  };
}

/** The token estimate the budget is charged against one request's bytes. */
export function estimateTokens(text: string): number {
  return estimateTokenCount(text);
}

/** One probe reading attributed to the cell that produced it. */
export interface ProbeObservation {
  readonly cellId: string;
  readonly candidateId: string;
  readonly probe: ProbeReading;
}

/**
 * What a matrix's probe answers add up to.
 *
 * `answered` counts the legal options, including the model's own `unknown`;
 * `unreadable` counts the answers this pipeline could not read at all. Keeping them
 * apart is what stops "the reviewer declined" from being reported as "the reviewer
 * ignored the question".
 */
export interface ProbeSummary {
  readonly asked: number;
  readonly answered: Readonly<Record<string, number>>;
  readonly unreadable: number;
  readonly notAsked: number;
}
