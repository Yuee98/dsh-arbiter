/**
 * Reading a candidate-B chat answer without forking the answer contract.
 *
 * Candidate B's chat answer carries one extra member, `recoverability`. Production's
 * reader accepts exactly the two score members, and that strictness is deliberate: a
 * model that adds a field is not answering the question it was asked. An experiment
 * cannot loosen production just to accommodate its own prompt, so this module removes
 * the probe member, hands the remaining object to the production reader, and reports
 * the probe beside the scores.
 *
 * Two properties follow, and they are what the tests pin:
 *
 *   - the scores are the production reader's own values, produced by the production
 *     code path. A variant cannot grade differently.
 *   - a missing or unreadable probe leaves a readable answer readable. The probe is
 *     measurement material; it never turns a scored review into a failure.
 */

import { extractJsonObject } from './json.js';
import { PROBE_MEMBER, readProbeAnswer, type ProbeReading } from './probe.js';
import type { ParsedAnswer } from './signals.js';
import { readChatAnswer } from './signals.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A candidate-B chat answer: the production reading, plus the probe beside it. */
export interface VariantChatReading {
  /** Exactly what the production reader returned for the two score members. */
  readonly scored: ParsedAnswer;
  /** The probe reading, which is never part of the scores. */
  readonly probe: ProbeReading;
}

/**
 * Read a candidate-B chat answer.
 *
 * The object is parsed here only to locate and remove the probe member; the two score
 * members are then read by the production reader from what remains. A body that is not
 * a JSON object at all is handed to the production reader unchanged, so its error is
 * the production error rather than a second wording invented here.
 */
export function readVariantChatAnswer(text: string): VariantChatReading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(text));
  } catch {
    return {
      scored: readChatAnswer(text),
      probe: { status: 'unknown', reason: 'member-absent' },
    };
  }
  if (!isRecord(parsed)) {
    return {
      scored: readChatAnswer(text),
      probe: { status: 'unknown', reason: 'member-absent' },
    };
  }
  const probe = readProbeAnswer(parsed[PROBE_MEMBER]);
  const { [PROBE_MEMBER]: _removed, ...scored } = parsed;
  return { scored: readChatAnswer(JSON.stringify(scored)), probe };
}
