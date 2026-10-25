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

function parentLimits(
  contextValue: Record<string, unknown>,
  errors: ConfigError[],
): Pick<ContextConfig, 'parentHumanItems' | 'parentEvidenceFloor'> {
  const parentHumanItems = asInteger(
    contextValue['parentHumanItems'],
    5,
    0,
    100,
    'context.parentHumanItems',
    errors,
  );
  const parentEvidenceFloor = asInteger(
    contextValue['parentEvidenceFloor'],
    1,
    0,
    100,
    'context.parentEvidenceFloor',
    errors,
  );
  if (parentEvidenceFloor > parentHumanItems) {
    errors.push({
      path: 'context.parentEvidenceFloor',
      message: 'must not exceed context.parentHumanItems',
      code: 'relation.parentEvidenceFloor',
    });
  }
  return { parentHumanItems, parentEvidenceFloor };
}

export function parseContext(
  raw: Record<string, unknown>,
  errors: ConfigError[],
): ContextConfig {
  // An explicitly supplied non-object parent is an error; absence keeps defaults.
  const contextRaw = raw['context'];
  if (contextRaw !== undefined && !isRecord(contextRaw)) {
    errors.push({
      path: 'context',
      message: 'must be an object',
      code: 'type.object',
    });
  }
  const contextValue = isRecord(contextRaw) ? contextRaw : {};
  const customRules = asString(
    contextValue['customRules'],
    '',
    'context.customRules',
    errors,
  );
  if (customRules.length > 2_000) {
    errors.push({
      path: 'context.customRules',
      message: 'must be at most 2000 characters',
      code: 'length.customRules',
      params: { max: 2_000 },
    });
  }
  const { parentHumanItems, parentEvidenceFloor } = parentLimits(
    contextValue,
    errors,
  );
  const context: ContextConfig = {
    maxInputTokens: asInteger(
      contextValue['maxInputTokens'],
      10_000,
      1_000,
      200_000,
      'context.maxInputTokens',
      errors,
    ),
    evidenceMaxItems: asInteger(
      contextValue['evidenceMaxItems'],
      20,
      1,
      200,
      'context.evidenceMaxItems',
      errors,
    ),
    parentHumanItems,
    parentEvidenceFloor,
    historyMaxItems: asInteger(
      contextValue['historyMaxItems'],
      40,
      1,
      400,
      'context.historyMaxItems',
      errors,
    ),
    checkpointMaxItems: asInteger(
      contextValue['checkpointMaxItems'],
      3,
      0,
      20,
      'context.checkpointMaxItems',
      errors,
    ),
    toolCallArgumentMaxChars: asInteger(
      contextValue['toolCallArgumentMaxChars'],
      200,
      20,
      10_000,
      'context.toolCallArgumentMaxChars',
      errors,
    ),
    customRules,
    projectRules: parseProjectRules(contextValue, errors),
  };

  return context;
}
