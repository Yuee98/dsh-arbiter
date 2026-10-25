import type { ConfigError, ContextConfig } from '../types.js';
import { isRecord, asString, asInteger, asBoolean } from './values.js';

function parseProjectRules(
  contextValue: Record<string, unknown>,
): ContextConfig['projectRules'] {
  const projectValue = isRecord(contextValue['projectRules'])
    ? contextValue['projectRules']
    : {};
  const projectFiles = Array.isArray(projectValue['files'])
    ? projectValue['files'].filter(
        (file): file is string => typeof file === 'string',
      )
    : ['.dsh/arbiter.md', '.arbiter.md'];
  return {
    enabled: asBoolean(projectValue['enabled'], true),
    files:
      projectFiles.length > 0
        ? projectFiles
        : ['.dsh/arbiter.md', '.arbiter.md'],
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
    projectRules: parseProjectRules(contextValue),
  };

  return context;
}
