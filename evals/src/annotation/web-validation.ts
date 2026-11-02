import { checked } from './workflow-validation.js';
import type { WebForm, WebMutation } from './web-types.js';

export const webFormSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['pairs', 'behaviour', 'rationale', 'evidence', 'author', 'state'],
  properties: {
    noScores: { type: 'boolean' },
    pairs: { type: 'string', maxLength: 8000 },
    behaviour: {
      enum: [
        '',
        'allow',
        'deny',
        'escalate',
        'insufficient-material',
        'review-failure',
      ],
    },
    rationale: { type: 'string', maxLength: 64000 },
    evidence: { type: 'string', maxLength: 64000 },
    author: { type: 'string', maxLength: 1000 },
    state: { enum: ['confirmed', 'disputed', 'undecidable', 'needs-review'] },
  },
};
export function webForm(value: unknown): WebForm {
  return checked<WebForm>(webFormSchema, value);
}
export function webMutation(value: unknown): WebMutation {
  return checked<WebMutation>(
    {
      type: 'object',
      additionalProperties: false,
      required: ['token', 'revision', 'form', 'sampled'],
      properties: {
        token: { type: 'string', pattern: '^[a-f0-9-]{36}$' },
        revision: { type: 'integer', minimum: 0 },
        form: webFormSchema,
        sampled: { type: 'boolean' },
      },
    },
    value,
  );
}
