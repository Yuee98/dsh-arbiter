import type { ConfigError, ContextConfig } from '../types.js';
import { isRecord, asString, asInteger, asBoolean } from './values.js';

/** The only files that may supply PROJECT_RULES, in preference order. */
export const PROJECT_RULE_FILES = ['.dsh/arbiter.md', '.arbiter.md'] as const;

function parseProjectRules(
  contextValue: Record<string, unknown>,
  errors: ConfigError[],
): ContextConfig['projectRules'] {
  const projectValue = isRecord(contextValue['projectRules'])
    ? contextValue['projectRules']
    : {};
  const requested = Array.isArray(projectValue['files'])
    ? projectValue['files'].filter(
        (file): file is string => typeof file === 'string',
      )
    : PROJECT_RULE_FILES;
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
    });
  }
  return {
    enabled: asBoolean(projectValue['enabled'], true),
    files: allowed.length > 0 ? allowed : PROJECT_RULE_FILES,
  };
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
    });
  }
  return { parentHumanItems, parentEvidenceFloor };
}

export function parseContext(
  raw: Record<string, unknown>,
  errors: ConfigError[],
): ContextConfig {
  const contextValue = isRecord(raw['context']) ? raw['context'] : {};
  const customRules = asString(contextValue['customRules'], '');
  if (customRules.length > 2_000) {
    errors.push({
      path: 'context.customRules',
      message: 'must be at most 2000 characters',
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
