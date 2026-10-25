import type { ModelGroupView, ModelOptionView } from './view-types.js';

/**
 * One Reviewer chat route as the configuration stores it.
 *
 * The provider `session` is not a model: it means "use whatever route the
 * reviewed call itself came from", so its model stays empty.
 */
export interface ModelChoice {
  readonly provider: string;
  readonly model: string;
}

export const SESSION_PROVIDER = 'session';

export const SESSION_CHOICE: ModelChoice = {
  provider: SESSION_PROVIDER,
  model: '',
};

export function isSessionChoice(choice: ModelChoice): boolean {
  return choice.provider === SESSION_PROVIDER;
}

/**
 * One stable `<select>` value for a provider/model pair.
 *
 * Provider and model ids are opaque protocol values that may contain `/`, `:`
 * or whitespace, so joining them with a separator would let two distinct pairs
 * collapse into one value. A JSON tuple keeps the pair reversible.
 */
export function encodeChoice(choice: ModelChoice): string {
  return isSessionChoice(choice)
    ? SESSION_PROVIDER
    : JSON.stringify([choice.provider, choice.model]);
}

export function decodeChoice(value: string): ModelChoice | null {
  if (value === SESSION_PROVIDER) return SESSION_CHOICE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const parts: readonly unknown[] = parsed;
  if (parts.length !== 2) return null;
  const [provider, model] = parts;
  if (typeof provider !== 'string' || typeof model !== 'string') return null;
  if (provider.length === 0 || model.length === 0) return null;
  if (provider === SESSION_PROVIDER) return null;
  return { provider, model };
}

/** A catalogue entry as one selectable option, with its provider identity kept. */
export interface ModelOption extends ModelChoice {
  readonly providerName: string;
  readonly name: string;
}

export function catalogueOptions(
  groups: readonly ModelGroupView[],
): readonly ModelOption[] {
  return groups.flatMap((group) =>
    group.models.map((model) => ({
      provider: group.id,
      providerName: group.name,
      model: model.id,
      name: model.name,
    })),
  );
}

function matchesGroup(group: ModelGroupView, query: string): boolean {
  return (
    group.id.toLowerCase().includes(query) ||
    group.name.toLowerCase().includes(query)
  );
}

function matchesModel(model: ModelOptionView, query: string): boolean {
  return (
    model.id.toLowerCase().includes(query) ||
    model.name.toLowerCase().includes(query)
  );
}

/**
 * Narrow the catalogue to a search query.
 *
 * A provider whose own name matches keeps all of its models; otherwise only
 * the matching models remain, and a provider left with none disappears instead
 * of rendering an empty group.
 */
export function filterModelGroups(
  groups: readonly ModelGroupView[],
  query: string,
): readonly ModelGroupView[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return groups;
  return groups.flatMap((group) => {
    if (matchesGroup(group, needle)) return [group];
    const models = group.models.filter((model) => matchesModel(model, needle));
    return models.length === 0 ? [] : [{ ...group, models }];
  });
}

export function choiceInGroups(
  groups: readonly ModelGroupView[],
  choice: ModelChoice,
): boolean {
  return catalogueOptions(groups).some(
    (option) =>
      option.provider === choice.provider && option.model === choice.model,
  );
}
