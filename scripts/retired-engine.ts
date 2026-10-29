/**
 * Whether the frozen R1–R9 reproducer's engine still exists in this build.
 *
 * The historical script is kept byte-identical as prototype evidence, and it
 * imports five symbols from the built library at module scope. The shared-contract
 * switch removed those symbols, so the script now fails before it can run a single
 * case — and a script that cannot run produces no `results.json`.
 *
 * Treating that missing file as a pass would be a name-based exemption: it would
 * accept *any* reason the script failed, including a genuine defect. This module is
 * the positive alternative. It inspects the built library and states, symbol by
 * symbol, which of the five the build still exports. The caller may only retire the
 * historical run when the probe reports **all five absent**; if even one is back,
 * the script has to run and pass on its own merits.
 *
 * The symbol list is the contract: it is what the script imports, so it is what must
 * disappear before the run can be retired.
 */

/**
 * The exact symbols the frozen script imports.
 *
 * Kept as data rather than inlined in the probe so the check, the verdict and the
 * tests all read the same list — a probe that looked for a subset would call the
 * engine retired while the script still had something to import.
 */
export const RETIRED_ENGINE_SYMBOLS = [
  { module: 'policy', symbol: 'decideReview' },
  { module: 'reviewer', symbol: 'signalsFromChat' },
  { module: 'reviewer', symbol: 'renderRequest' },
  { module: 'reviewer', symbol: 'runDecisionReviewer' },
  { module: 'reviewer', symbol: 'parseDecisionResponse' },
] as const;

export type RetiredEngineModule = 'policy' | 'reviewer';

/** One probe result: which symbols the build still exports, per module. */
export interface EngineProbeReport {
  /** `<module>.<symbol>` for every listed symbol the build no longer exports. */
  readonly absent: readonly string[];
  /** `<module>.<symbol>` for every listed symbol the build still exports. */
  readonly present: readonly string[];
  /** Why the probe itself could not read a module, if it could not. */
  readonly unreadable: readonly string[];
}

/** The `<module>.<symbol>` label one entry uses in a report. */
export function symbolLabel(entry: {
  readonly module: RetiredEngineModule;
  readonly symbol: string;
}): string {
  return `${entry.module}.${entry.symbol}`;
}

/** Every label the probe is expected to report on. */
export function expectedEngineLabels(): readonly string[] {
  return RETIRED_ENGINE_SYMBOLS.map((entry) => symbolLabel(entry));
}
