import { describe, expect, it } from 'vitest';
import type { RunPlan } from '../../evals/src/run/types.js';
import { chatTarget } from '../evals/helpers/run.js';
import {
  compared,
  savedRun,
  syntheticReferences,
} from '../evals/helpers/version-comparison.js';
import { withWorkflowArea } from '../evals/helpers/workflow-run.js';

describe(
  'private transport conditions in version comparisons',
  { timeout: 60_000 },
  () => {
    it.each([
      { field: 'url', auth: 'userinfo' },
      { field: 'apiKeyRef', auth: 'userinfo' },
      { field: 'credentialRef', auth: 'userinfo' },
      { field: 'costTier', auth: 'userinfo' },
      { field: 'url', auth: 'encoded-userinfo' },
      { field: 'url', auth: 'query' },
    ] as const)(
      'discloses decision $field with $auth without publishing private route configuration',
      async ({ field, auth }) => {
        await withWorkflowArea(async (area) => {
          const secret =
            auth === 'userinfo'
              ? 'synthetic_endpoint_bearer_133'
              : 'synthetic endpoint + bearer/133';
          const endpoint = (host: string) =>
            auth === 'query'
              ? `https://${host}/v1/systemone?api_key=${encodeURIComponent(secret)}`
              : `https://private-user:${auth === 'encoded-userinfo' ? encodeURIComponent(secret) : secret}@${host}/v1/systemone`;
          const original: RunPlan = {
            ...area.plan,
            targets: area.plan.targets.map((target) => ({
              ...target,
              model: secret,
              decision:
                target.decision === null
                  ? null
                  : {
                      ...target.decision,
                      model: secret,
                      url: endpoint('private-old.invalid'),
                      apiKeyRef: 'PRIVATE_OLD_LOOKUP_133',
                    },
            })),
          };
          const alternative: RunPlan = {
            ...original,
            targets: original.targets.map((target) => ({
              ...target,
              ...(field === 'credentialRef'
                ? { credentialRef: 'PRIVATE_NEW_LOOKUP_133' }
                : {}),
              decision:
                target.decision === null
                  ? null
                  : {
                      ...target.decision,
                      ...(field === 'url'
                        ? {
                            url: endpoint('private-new.invalid'),
                          }
                        : {}),
                      ...(field === 'apiKeyRef'
                        ? { apiKeyRef: 'PRIVATE_NEW_LOOKUP_133' }
                        : {}),
                      ...(field === 'costTier'
                        ? { costTier: 'paid' as const }
                        : {}),
                    },
            })),
          };
          const baseline = await savedRun(area, 'baseline', original),
            current = await savedRun(area, 'current', alternative);
          const refs = await syntheticReferences(area, 'refs', original);
          const result = await compared(area, baseline, current, refs);
          expect(result.section.behaviour.paired).toBe(2);
          const reason =
            field === 'costTier'
              ? 'cost-tier-configuration'
              : 'execution-route';
          expect(
            result.section.rows.every((row) =>
              row.conditionChanges.includes(reason),
            ),
          ).toBe(true);
          for (const format of result.formats) {
            expect(format).toContain(reason);
            expect(format).not.toContain(secret);
            expect(format).not.toContain('private-old.invalid');
            expect(format).not.toContain('private-new.invalid');
            expect(format).not.toContain('PRIVATE_OLD_LOOKUP_133');
            expect(format).not.toContain('PRIVATE_NEW_LOOKUP_133');
          }
        });
      },
    );
    it.each(['maxRepairRetries', 'reasoningEffort'] as const)(
      'retains a chat %s condition change even when private values are omitted from the public projection',
      async (field) => {
        await withWorkflowArea(async (area) => {
          const original: RunPlan = {
            ...area.plan,
            protocols: ['chat'],
            targets: [
              chatTarget('same-chat', {
                maxRepairRetries: 0,
                reasoningEffort: 'PRIVATE_EFFORT_A_133',
              }),
            ],
          };
          const alternative: RunPlan = {
            ...original,
            targets: [
              chatTarget('same-chat', {
                maxRepairRetries: field === 'maxRepairRetries' ? 2 : 0,
                reasoningEffort:
                  field === 'reasoningEffort'
                    ? 'PRIVATE_EFFORT_B_133'
                    : 'PRIVATE_EFFORT_A_133',
              }),
            ],
          };
          const baseline = await savedRun(area, 'baseline', original),
            current = await savedRun(area, 'current', alternative);
          const refs = await syntheticReferences(area, 'refs', original);
          const result = await compared(area, baseline, current, refs);
          expect(result.section.behaviour.paired).toBe(2);
          const reason =
            field === 'maxRepairRetries'
              ? 'repair-configuration'
              : 'model-settings';
          expect(
            result.section.rows.every((row) =>
              row.conditionChanges.includes(reason),
            ),
          ).toBe(true);
          for (const format of result.formats) {
            expect(format).toContain(reason);
            expect(format).not.toContain('PRIVATE_EFFORT_A_133');
            expect(format).not.toContain('PRIVATE_EFFORT_B_133');
          }
        });
      },
    );
  },
);
