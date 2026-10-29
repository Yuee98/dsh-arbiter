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

import { caseMaterial } from '../run/material.js';
import type { RunProtocol } from '../run/types.js';

import type { ResolvedCandidate } from './inspect.js';

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
}): ExperimentCell {
  const material = caseMaterial(parts.caseEntry, parts.protocol, {
    maxInputTokens: parts.maxInputTokens,
  });
  // The production renderer itself, so a full-layout candidate submits the production
  // bytes rather than a copy that happens to look the same.
  const request =
    parts.protocol === 'chat'
      ? renderVariantChatRequest(
          material.snapshot,
          parts.candidate.variant,
          renderMaterial,
        )
      : renderVariantDecisionRequest(
          material.snapshot,
          parts.candidate.variant,
          renderMaterial,
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
    estimatedInputTokens: request.estimatedInputTokens,
    promptFingerprint: digestOf({ protocol: parts.protocol, request }),
  };
}

/** One candidate's cells, all cases, protocols and repeats included. */
function expandCandidate(parts: {
  readonly candidate: ResolvedCandidate;
  readonly cases: readonly ReviewCase[];
  readonly protocols: readonly RunProtocol[];
  readonly repeats: number;
  readonly maxInputTokens: number;
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
  const candidates = parts.candidates.map((candidate) =>
    expandCandidate({
      candidate,
      cases: parts.cases,
      protocols: parts.protocols,
      repeats: parts.repeats,
      maxInputTokens: parts.maxInputTokens,
    }),
  );
  return {
    candidates,
    cells: candidates.reduce((sum, entry) => sum + entry.cells.length, 0),
    estimatedInputTokens: candidates.reduce(
      (sum, entry) => sum + entry.estimatedInputTokens,
      0,
    ),
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
