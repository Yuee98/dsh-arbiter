import type { ConfigError, ContextConfig } from '../types.js';
import { asBoolean, asInteger, asString, isRecord } from './values.js';

/** The only files that may supply PROJECT_RULES, in preference order. */
export const PROJECT_RULE_FILES = ['.dsh/arbiter.md', '.arbiter.md'] as const;

function parseProjectRules(
  contextValue: Record<string, unknown>,
  errors: ConfigError[],
): ContextConfig['projectRules'] {
  // A supplied parent must be an object; absence keeps the defaults.
  const raw = contextValue['projectRules'];
  if (raw !== undefined && !isRecord(raw)) {
    errors.push({
      path: 'context.projectRules',
      message: 'must be an object',
      code: 'type.object',
    });
  }
  const projectValue = isRecord(raw) ? raw : {};
  const requested = parseProjectFiles(
    projectValue['files'],
    'context.projectRules.files',
    errors,
  );
  // Only the two documented workspace-root files can carry PROJECT_RULES; a
  // configured relative path such as ../outside.md must not become guidance.
  const allowed = requested.filter((file) =>
    (PROJECT_RULE_FILES as readonly string[]).includes(file),
  );
  if (
    requested.some(
      (file) => !(PROJECT_RULE_FILES as readonly string[]).includes(file),
    )
  ) {
    errors.push({
      path: 'context.projectRules.files',
      message: `must be one of ${PROJECT_RULE_FILES.join(', ')}`,
      code: 'context.project-files',
      params: { allowed: PROJECT_RULE_FILES.join(', ') },
    });
  }
  return {
    enabled: asBoolean(
      projectValue['enabled'],
      true,
      'context.projectRules.enabled',
      errors,
    ),
    // The owner of PROJECT_RULES decides this fallback: an empty or fully
    // rejected selection still reads the two documented files.
    files: allowed.length > 0 ? allowed : PROJECT_RULE_FILES,
  };
}

/** A supplied file list must be an array of strings; absent means the default. */
function parseProjectFiles(
  value: unknown,
  path: string,
  errors: ConfigError[],
): readonly string[] {
  if (value === undefined) return PROJECT_RULE_FILES;
  if (!Array.isArray(value) || value.some((file) => typeof file !== 'string')) {
    errors.push({
      path,
      message: 'must be an array of strings',
      code: 'type.string-array',
    });
    return PROJECT_RULE_FILES;
  }
  const values: readonly unknown[] = value;
  return values.filter((file): file is string => typeof file === 'string');
}

export function parseContext(
  raw: Record<string, unknown>,
  errors: ConfigError[],
): ContextConfig {
  const contextRaw = raw['context'];
  if (contextRaw !== undefined && !isRecord(contextRaw)) {
    errors.push({
      path: 'context',
      message: 'must be an object',
      code: 'type.object',
    });
  }
  const value = isRecord(contextRaw) ? contextRaw : {};
  const maxInputTokens = asInteger(
    value['maxInputTokens'],
    10_000,
    1,
    Number.MAX_SAFE_INTEGER,
    'context.maxInputTokens',
    errors,
  );
  const targetInputTokens = asInteger(
    value['targetInputTokens'],
    Math.min(6_000, maxInputTokens),
    1,
    Number.MAX_SAFE_INTEGER,
    'context.targetInputTokens',
    errors,
  );
  if (targetInputTokens > maxInputTokens) {
    errors.push({
      path: 'context.targetInputTokens',
      message: 'must not exceed context.maxInputTokens',
      code: 'relation.targetInputTokens',
    });
  }
  return {
    targetInputTokens,
    maxInputTokens,
    customRules: asString(
      value['customRules'],
      '',
      'context.customRules',
      errors,
    ),
    projectRules: parseProjectRules(value, errors),
  };
}
