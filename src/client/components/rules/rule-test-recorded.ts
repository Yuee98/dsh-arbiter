/**
 * Which recorded call seeded the tester, and whether it still does.
 *
 * The tester can be filled by typing a sample, by importing a call, or by a rule
 * draft that was built from a call. Only the last two know a recorded call, and
 * only while the inputs still equal that call's recorded ones: once anything is
 * edited, the answer is about a sample someone built, not about the call. Keeping
 * that comparison pure lets both the note and its tests read one definition.
 */

import { useEffect, useRef } from 'react';
import type { SessionKind } from '../../../types.js';
import type { TestInputMode } from './rule-test-model.js';
import type { ImportedTestSample } from './rule-test-source.js';

/** The recorded call a sample came from, as the tester holds it. */
export interface RecordedSample {
  readonly callId: string;
  readonly tool: string;
  readonly text: string;
  readonly mode: TestInputMode;
  readonly identity: SessionKind;
  readonly cwd: string;
}

/** The tester's current inputs, in the shape the comparison needs. */
export interface SampleInputs {
  readonly tool: string;
  readonly text: string;
  readonly mode: TestInputMode;
  readonly identity: SessionKind;
  readonly cwd: string;
}

/** The recorded call the inputs came from, when they still are that call. */
export function recordedStillMatches(
  source: RecordedSample | null,
  inputs: SampleInputs,
): boolean {
  if (source === null) return false;
  return (
    source.tool === inputs.tool &&
    source.text === inputs.text &&
    source.mode === inputs.mode &&
    source.identity === inputs.identity &&
    source.cwd === inputs.cwd
  );
}

/** The recorded call an imported sample names, in the tester's own words. */
export function recordedSampleOf(
  callId: string,
  imported: ImportedTestSample,
): RecordedSample {
  return {
    callId,
    tool: imported.sample.tool,
    text: imported.sample.input,
    // An imported call is always replayed as its argument object; a command-mode
    // replay would evaluate only a string the record also happened to carry.
    mode: 'arguments',
    identity: imported.identity,
    cwd: imported.cwd ?? '',
  };
}

/**
 * Apply one seed request exactly once.
 *
 * A new request is a new nonce, so re-opening the same call reloads its recorded
 * values instead of keeping whatever was typed in between; an unchanged request
 * is not re-applied on every render.
 */
export function useSeedApplication(
  seed: { readonly nonce: number } | undefined,
  apply: () => void,
): void {
  const applied = useRef(0);
  useEffect(() => {
    if (seed === undefined || seed.nonce === applied.current) return;
    applied.current = seed.nonce;
    apply();
  }, [seed, apply]);
}
