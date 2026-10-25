import type { CandidateView, ReplayView } from '../view-types.js';
import {
  array,
  boolean,
  choice,
  field,
  nullable,
  number,
  object,
  text,
  unknownValue,
} from './values.js';

function candidate(value: unknown): CandidateView {
  const source = object(value);
  return {
    candidateId: field(source, 'candidateId', text),
    createdAt: field(source, 'createdAt', number),
    status: field(source, 'status', choice('pending', 'accepted', 'rejected')),
    rule: field(source, 'rule', unknownValue),
    stats: field(source, 'stats', unknownValue),
    evidence: field(source, 'evidence', unknownValue),
    windowStart: field(source, 'windowStart', number),
    windowEnd: field(source, 'windowEnd', number),
    note: field(source, 'note', nullable(text)),
  };
}

export function suggestionsResponse(value: unknown) {
  const source = object(value);
  return {
    ok: field(source, 'ok', boolean),
    candidates: field(source, 'candidates', array(candidate)),
  };
}

export function analyzeResponse(value: unknown) {
  const source = object(value);
  return {
    ok: field(source, 'ok', boolean),
    proposals: field(source, 'proposals', array(unknownValue)),
    created: field(source, 'created', number),
  };
}

export function replayResponse(value: unknown): ReplayView {
  const source = object(value);
  return {
    considered: field(source, 'considered', number),
    comparable: field(source, 'comparable', number),
    promoted: field(source, 'promoted', number),
    normalAllow: field(source, 'normalAllow', number),
    progressAllow: field(source, 'progressAllow', number),
    changed: field(source, 'changed', number),
    skipped: field(source, 'skipped', number),
    items: field(
      source,
      'items',
      array((value) => {
        const item = object(value);
        return {
          callId: field(item, 'callId', text),
          tool: field(item, 'tool', text),
          normal: field(item, 'normal', text),
          progress: field(item, 'progress', text),
          promoted: field(item, 'promoted', boolean),
        };
      }),
    ),
  };
}
