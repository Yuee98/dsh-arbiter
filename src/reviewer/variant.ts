/**
 * The controlled package variants an experiment may compare.
 *
 * The design (`docs/milestones/review-quality-and-evals.md` 2.4) asks for two
 * candidates under one rubric and for the prompt, history and scale ablations to be
 * compared item by item. A variant is therefore *four independent axes*, not a set of
 * hand-written prompts: each axis changes one thing, and a candidate that changes two
 * at once cannot say which one moved the result.
 *
 *   prompt      no probe (candidate A) or the one recovery/withdrawal question (B)
 *   structure   production layout, or the compact layout, or the compact layout
 *               without the audit-only metadata fields
 *   history     this turn's tool history, or the ablation that withholds it
 *   scale       the complete operational band text, or the one-line band labels
 *
 * Two rules make this safe to have in `src/reviewer/` at all:
 *
 *   - production never selects a variant. {@link DEFAULT_REVIEW_VARIANT} is the
 *     production package, `review()` always uses it, and the experimental entry point
 *     is a separate function. So "the experiment changed the default" cannot happen by
 *     editing a constant.
 *   - the identity is derivable. {@link variantIdFor} hashes the four axes, so two
 *     candidates with the same id are the same package and two packages cannot share
 *     an id. A record that names a variant can be re-rendered from it.
 *
 * What no axis may change: the two scales' ten bands, the common matrix, the risk
 * definition (a probe never moves the risk band), and the prohibition/withdrawal rule.
 * Those are asserted in tests rather than promised here.
 */

/** The version of the variant vocabulary. A new axis value needs a new value. */
export const REVIEW_VARIANT_VERSION = 'review-variant-v1';

/** Which prompt package a variant asks for. */
export type PromptVariant =
  /** Candidate A: the two bands and the answer shape, nothing else. */
  | 'no-probe'
  /** Candidate B: the two bands plus the one recovery/withdrawal question. */
  | 'recovery-probe';

/**
 * How the material is laid out.
 *
 * The three steps are the design's own order: the compact layout removes prose that
 * only restates the contract, and the no-audit step then removes the fields that
 * describe the submission rather than judge it. The second step is defined *on top
 * of* the first so a comparison can attribute a change to exactly one step.
 */
export type StructureVariant =
  /** Production layout, unchanged. */
  | 'full'
  /** One labelled JSON envelope; notes that duplicate the contract are gone. */
  | 'compact'
  /** Compact, with `config_revision`, `turn`, material char counts and the budget block removed. */
  | 'compact-no-audit';

/** Which tool history the material carries. */
export type HistoryVariant =
  /** This turn's calls, oldest first — the production scope. */
  | 'current-turn'
  /**
   * The history-selection ablation.
   *
   * The block is still present and says it was withheld, so the reader learns a fact
   * about the submission instead of inferring "the turn was empty". Authorization
   * evidence is a different block and is never affected.
   */
  | 'none';

/** How much of each band the prompt prints. */
export type ScaleVariant =
  /** The complete operational text from `rubric-text.ts`. */
  | 'complete'
  /**
   * The canonical one-line criterion per band, plus the preserved guard paragraph.
   *
   * The guard is what keeps the compression honest: the prohibition/withdrawal rule,
   * the cumulative-coverage rule and "recovery cost stays inside the risk band" are
   * re-stated even when the per-band prose is not.
   */
  | 'labels';

/** One package variant, identified by its four axes. */
export interface ReviewVariant {
  /** The derived identity; see {@link variantIdFor}. */
  readonly variantId: string;
  readonly prompt: PromptVariant;
  readonly structure: StructureVariant;
  readonly history: HistoryVariant;
  readonly scale: ScaleVariant;
}

/**
 * The package production uses.
 *
 * Every axis is at its baseline and the prompt is candidate A, because the design's
 * first choice is no probe. `review()` uses this constant, so an experiment cannot
 * change production by editing a value here without changing production itself —
 * which is exactly the review this file's tests demand.
 */
export const PRODUCTION_VARIANT: ReviewVariant = {
  variantId: 'rq14/no-probe.complete.current-turn.full',
  prompt: 'no-probe',
  structure: 'full',
  history: 'current-turn',
  scale: 'complete',
};

/** The four axes, in the order the identity states them. */
const AXIS_ORDER = ['prompt', 'scale', 'history', 'structure'] as const;

/** The axes of a variant, without its derived identity. */
export type VariantAxes = Omit<ReviewVariant, 'variantId'>;

/**
 * The identity of one package.
 *
 * The axes are joined in a fixed order with `.` between them, so the id states the
 * whole package: a reader can tell two candidates apart without reading the
 * experiment record, and a stored id can be re-expanded to the variant it names.
 */
export function variantIdFor(axes: VariantAxes): string {
  return `rq14/${AXIS_ORDER.map((axis) => axes[axis]).join('.')}`;
}

/** Build a variant, deriving its identity from the axes. */
export function defineVariant(axes: VariantAxes): ReviewVariant {
  return { variantId: variantIdFor(axes), ...axes };
}

/** The axes a variant id names, or null when it names no package of this vocabulary. */
export function parseVariantId(
  variantId: string,
): { readonly ok: true; readonly axes: VariantAxes } | { readonly ok: false } {
  const match = /^rq14\/([a-z-]+)\.([a-z-]+)\.([a-z-]+)\.([a-z-]+)$/u.exec(
    variantId,
  );
  if (match === null) return { ok: false };
  const [, prompt, scale, history, structure] = match;
  if (
    !isPromptVariant(prompt) ||
    !isScaleVariant(scale) ||
    !isHistoryVariant(history) ||
    !isStructureVariant(structure)
  ) {
    return { ok: false };
  }
  return { ok: true, axes: { prompt, scale, history, structure } };
}

function isPromptVariant(value: string | undefined): value is PromptVariant {
  return value === 'no-probe' || value === 'recovery-probe';
}

function isStructureVariant(
  value: string | undefined,
): value is StructureVariant {
  return (
    value === 'full' || value === 'compact' || value === 'compact-no-audit'
  );
}

function isHistoryVariant(value: string | undefined): value is HistoryVariant {
  return value === 'current-turn' || value === 'none';
}

function isScaleVariant(value: string | undefined): value is ScaleVariant {
  return value === 'complete' || value === 'labels';
}

/** Whether this variant is the production package, which no experiment may claim. */
export function isProductionVariant(variant: ReviewVariant): boolean {
  return variant.variantId === PRODUCTION_VARIANT.variantId;
}

/**
 * Which axes differ between two variants, named in {@link AXIS_ORDER}.
 *
 * An empty list means the two names are the same package. The experiment composer
 * uses this to require that a ladder step changes exactly one axis, which is what
 * makes "compare the probe's effect" a measurement rather than an attribution.
 */
export function variantDiff(
  from: ReviewVariant,
  to: ReviewVariant,
): readonly (typeof AXIS_ORDER)[number][] {
  return AXIS_ORDER.filter((axis) => from[axis] !== to[axis]);
}

/**
 * The axes a variant changes relative to the production package.
 *
 * This is what the experiment record prints as a candidate's diff, so a reader sees
 * the treatment without comparing four strings by eye.
 */
export function productionDiff(
  variant: ReviewVariant,
): readonly (typeof AXIS_ORDER)[number][] {
  return variantDiff(PRODUCTION_VARIANT, variant);
}
