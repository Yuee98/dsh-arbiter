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

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArbiterConfig, SnapshotMaterial } from '../types.js';

const PROJECT_RULES_LIMIT = 2_000;
const CUSTOM_RULES_LIMIT = 2_000;
/** The two guidance sources share this combined ceiling. */
const GUIDANCE_LIMIT = 3_000;

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
      limit: PROJECT_RULES_LIMIT,
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
export async function readProjectRules(
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
          limit: PROJECT_RULES_LIMIT,
          truncated: false,
          path: file,
        },
        missing: `PROJECT_RULES file "${file}" exists but could not be read; this source is unavailable and no other project file is substituted`,
        unreadable: true,
      };
    }
    const truncated = text.length > PROJECT_RULES_LIMIT;
    return {
      text: truncated ? text.slice(0, PROJECT_RULES_LIMIT) : text,
      material: {
        id: 'project-rules',
        enabled: true,
        present: true,
        chars: truncated ? PROJECT_RULES_LIMIT : text.length,
        limit: PROJECT_RULES_LIMIT,
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

function customRulesMaterial(
  submittedChars: number,
  truncated: boolean,
): SnapshotMaterial {
  return {
    id: 'custom-rules',
    enabled: true,
    present: submittedChars > 0,
    chars: submittedChars,
    limit: CUSTOM_RULES_LIMIT,
    truncated,
  };
}

function projectMaterial(
  material: SnapshotMaterial,
  submittedChars: number,
  truncated: boolean,
): SnapshotMaterial {
  return {
    ...material,
    present: material.present && submittedChars > 0,
    chars: submittedChars,
    truncated: material.truncated || truncated,
  };
}

/**
 * Apply the per-source caps and the shared guidance ceiling.
 *
 * CUSTOM_RULES yields first: it is user-global, while PROJECT_RULES is scoped to
 * this workspace and is the more specific instruction for this call.
 */
export function guidanceMaterials(
  customRulesRaw: string,
  project: ProjectRulesResult,
): GuidanceResult {
  const customCut = customRulesRaw.length > CUSTOM_RULES_LIMIT;
  const customRules = customRulesRaw.slice(0, CUSTOM_RULES_LIMIT);
  const projectSource = project.text;
  if (projectSource === null) {
    return {
      customRules,
      projectText: null,
      materials: [
        project.material,
        customRulesMaterial(customRules.length, customCut),
      ],
    };
  }
  const room = Math.max(0, GUIDANCE_LIMIT - customRules.length);
  const ceilingCut = projectSource.length > room;
  const projectText = ceilingCut ? projectSource.slice(0, room) : projectSource;
  return {
    customRules,
    projectText: projectText.length === 0 ? null : projectText,
    materials: [
      projectMaterial(project.material, projectText.length, ceilingCut),
      customRulesMaterial(customRules.length, customCut),
    ],
  };
}
