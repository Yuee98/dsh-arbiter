/**
 * The two configured guidance sources, as actually submitted.
 *
 * PROJECT_RULES is a file in the workspace; CUSTOM_RULES is a configuration
 * string. Both are user-authored material to interpret, so neither is ever put
 * in the system message, and every reduction is reflected in `materials` so the
 * snapshot describes the text that was submitted rather than the text that was
 * read.
 *
 * A missing file is normal — the user may simply not keep project guidance. A
 * file that exists but cannot be read is not normal: another candidate is *not*
 * substituted, because that would silently attribute one preference file's order
 * to text the user did not put first.
 */

import type { CredentialRedactor } from '../reviewer/credential-redactor.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArbiterConfig, SnapshotMaterial } from '../types.js';

export interface ProjectRulesResult {
  readonly text: string | null;
  readonly material: SnapshotMaterial;
  /** The reason this source is unavailable, or `null` when it answered. */
  readonly missing: string | null;
  /** Whether the reason describes an unreadable file rather than an absent one. */
  readonly unreadable: boolean;
}

function absentProjectRules(
  enabled: boolean,
  path: string | undefined,
  chars: number,
  truncated: boolean,
): ProjectRulesResult {
  return {
    text: null,
    material: {
      id: 'project-rules',
      enabled,
      present: false,
      chars,
      truncated,
      ...(path === undefined ? {} : { path }),
    },
    missing: null,
    unreadable: false,
  };
}

/** A missing file is normal; any other read error means that source failed. */
function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

/** Read the first *existing* candidate file, in the documented order. */
export async function readProjectRulesSource(
  cwd: string,
  config: ArbiterConfig['context']['projectRules'],
): Promise<ProjectRulesResult> {
  if (!config.enabled) return absentProjectRules(false, undefined, 0, false);
  const first = config.files[0];
  for (const file of config.files) {
    let text: string;
    try {
      text = await readFile(join(cwd, file), 'utf8');
    } catch (error: unknown) {
      if (isMissingFile(error)) continue;
      return {
        text: null,
        material: {
          id: 'project-rules',
          enabled: true,
          present: false,
          chars: 0,
          truncated: false,
          path: file,
        },
        missing: `PROJECT_RULES file "${file}" exists but could not be read; this source is unavailable and no other project file is substituted`,
        unreadable: true,
      };
    }
    const truncated = false;
    return {
      text,
      material: {
        id: 'project-rules',
        enabled: true,
        present: true,
        chars: text.length,
        truncated,
        path: file,
      },
      missing: null,
      unreadable: false,
    };
  }
  return {
    ...absentProjectRules(true, first, 0, false),
    missing:
      'PROJECT_RULES is enabled but none of the configured files could be read',
  };
}

export interface GuidanceResult {
  readonly customRules: string;
  readonly projectText: string | null;
  readonly materials: readonly SnapshotMaterial[];
}

/** Guidance remains whole until the shared T/H budget is applied. */
export function guidanceMaterials(
  customRulesRaw: string,
  project: ProjectRulesResult,
  redactor?: CredentialRedactor,
): GuidanceResult {
  const customRules = redactor?.text(customRulesRaw) ?? customRulesRaw;
  const projectText =
    project.text === null
      ? null
      : (redactor?.text(project.text) ?? project.text);
  const { limit: _oldLimit, ...material } = project.material;
  return {
    customRules,
    projectText,
    materials: [
      { ...material, chars: projectText?.length ?? 0 },
      {
        id: 'custom-rules',
        enabled: true,
        present: customRules.length > 0,
        chars: customRules.length,
        truncated: false,
      },
    ],
  };
}

/** Copy after common discovery; the token budget alone selects guidance. */
export function projectRulesCopy(
  source: ProjectRulesResult,
  redactor?: CredentialRedactor,
): ProjectRulesResult {
  const text =
    source.text === null ? null : (redactor?.text(source.text) ?? source.text);
  const { limit: _oldLimit, ...material } = source.material;
  return {
    ...source,
    text,
    material: { ...material, chars: text?.length ?? 0 },
  };
}
