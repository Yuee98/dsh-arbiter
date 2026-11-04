/** Private local drafts, not a second reference database. */
import { mkdir, lstat, open, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { HumanBatch } from './workflow-types.js';
import type { WebForm } from './web-types.js';
import { readJson } from './workflow-store.js';
import { checked } from './workflow-validation.js';
import { webFormSchema } from './web-validation.js';

export interface DraftPoint {
  token: string;
  group: string;
  rootId: string;
  pointId: string;
  viewId: string;
  workflow: number;
  position: number;
  batchId: string | null;
  revision: number;
  form: WebForm;
  status:
    | 'unopened'
    | 'draft'
    | 'confirmed'
    | 'disputed'
    | 'undecidable'
    | 'needs-review'
    | 'preparation-failed';
  sampled: boolean;
  exposed: boolean;
  intent: HumanBatch | null;
}
export interface DraftWorkspace {
  version: 'annotation-web-v1';
  scope: string;
  current: string | null;
  points: DraftPoint[];
}
const uuid = { type: 'string', pattern: '^[a-f0-9-]{36}$' };
const identity = { type: 'string', minLength: 1 };
export function draftWorkspace(value: unknown): DraftWorkspace {
  return checked<DraftWorkspace>(
    {
      type: 'object',
      additionalProperties: false,
      required: ['version', 'scope', 'current', 'points'],
      properties: {
        version: { const: 'annotation-web-v1' },
        scope: identity,
        current: { type: ['string', 'null'] },
        points: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'token',
              'group',
              'rootId',
              'pointId',
              'viewId',
              'workflow',
              'position',
              'batchId',
              'revision',
              'form',
              'status',
              'sampled',
              'exposed',
              'intent',
            ],
            properties: {
              token: uuid,
              group: identity,
              rootId: identity,
              pointId: identity,
              viewId: identity,
              workflow: { type: 'integer', minimum: 1 },
              position: { type: 'integer', minimum: 1 },
              batchId: { anyOf: [uuid, { type: 'null' }] },
              revision: { type: 'integer', minimum: 0 },
              form: webFormSchema,
              status: {
                enum: [
                  'unopened',
                  'draft',
                  'confirmed',
                  'disputed',
                  'undecidable',
                  'needs-review',
                  'preparation-failed',
                ],
              },
              sampled: { type: 'boolean' },
              exposed: { type: 'boolean' },
              intent: { type: ['object', 'null'] },
            },
          },
        },
      },
    },
    value,
  );
}
export async function privateDirectory(
  root: string,
  parts: readonly string[],
): Promise<string> {
  if (!(await lstat(root)).isDirectory())
    throw new Error('workspace root must be a regular directory');
  let directory = root;
  for (const part of parts) {
    directory = join(directory, part);
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'EEXIST'
      ))
        throw error;
    });
    if (!(await lstat(directory)).isDirectory())
      throw new Error('private workspace directory must not be symlinked');
  }
  return directory;
}
export async function atomicPrivateJson(
  path: string,
  value: unknown,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function withDraftClaim<T>(
  directory: string,
  body: () => Promise<T>,
): Promise<T> {
  const path = join(directory, '.draft.lock');
  const lock = await open(path, 'wx');
  try {
    return await body();
  } finally {
    await lock.close();
    await rm(path, { force: true });
  }
}
export async function loadDraft(path: string): Promise<DraftWorkspace | null> {
  try {
    return draftWorkspace(await readJson(path));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
}
