import type { ReactNode } from 'react';

import { useArbiterTranslation } from '../i18n-provider.js';
import {
  SESSION_CHOICE,
  catalogueOptions,
  choiceInGroups,
  encodeChoice,
  filterModelGroups,
  isSessionChoice,
} from '../model-choice.js';
import type { ModelChoice } from '../model-choice.js';
import { inputClassName } from './controls.js';
import type { ModelCatalogView, ModelGroupView } from '../view-types.js';

export type CatalogLoad = 'loading' | 'ready' | 'failed';

/** Provider display names that appear more than once in the catalog. */
function duplicateNames(
  groups: readonly ModelGroupView[],
): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const group of groups)
    counts.set(group.name, (counts.get(group.name) ?? 0) + 1);
  return new Set(
    [...counts].filter(([, count]) => count > 1).map(([name]) => name),
  );
}

/**
 * One option label that stays unambiguous when two providers share a name.
 *
 * The route (`provider / model`) is what the host stores, so it leads; a
 * differing display name follows only to keep models distinguishable. When two
 * providers share a display name, the route id is added because the display
 * name alone would render two different routes as identical text.
 */
function optionLabel(
  group: ModelGroupView,
  model: string,
  modelName: string,
  ambiguous: ReadonlySet<string>,
): string {
  const provider =
    ambiguous.has(group.name) && group.id !== group.name
      ? `${group.name}（${group.id}）`
      : group.name;
  const route = `${provider} / ${model}`;
  return modelName === model ? route : `${route}（${modelName}）`;
}

/** The label for the current draft route, whether or not it is filtered in. */
function currentLabel(
  catalog: ModelCatalogView | null,
  choice: ModelChoice,
  unlisted: (provider: string, model: string) => string,
): string {
  const groups = catalog?.groups ?? [];
  const ambiguous = duplicateNames(groups);
  for (const group of groups) {
    const model = group.models.find((entry) => entry.id === choice.model);
    if (group.id === choice.provider && model !== undefined)
      return optionLabel(group, model.id, model.name, ambiguous);
  }
  return unlisted(choice.provider, choice.model);
}

/**
 * The single Reviewer chat route selector.
 *
 * One `<select>` offers "follow the calling session" plus every configured host
 * model, grouped by provider. The current draft value is always representable:
 * a route missing from the visible options (still loading, failed, removed
 * since it was saved, or filtered out by the search) keeps its own selected
 * option, so a failed load never rewrites or hides the configured route.
 */
export function ModelSelect(props: {
  readonly choice: ModelChoice;
  readonly catalog: ModelCatalogView | null;
  readonly status: CatalogLoad;
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly onChoice: (choice: ModelChoice) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const { choice, catalog, status } = props;
  const groups =
    catalog === null ? [] : filterModelGroups(catalog.groups, props.query);
  const options = catalogueOptions(groups);
  // Ambiguity is a property of the whole catalog, not of the filtered view: a
  // search must not make two same-named providers look distinct again.
  const ambiguous = duplicateNames(catalog?.groups ?? []);
  const sessionChosen = choice.provider === SESSION_CHOICE.provider;
  const visible = options.some(
    (option) =>
      option.provider === choice.provider && option.model === choice.model,
  );
  const unlisted = (provider: string, model: string): string =>
    t('reviewer.model.unlisted', { provider, model });

  return (
    <div className="arb:flex arb:flex-col arb:gap-1.5">
      <input
        type="search"
        value={props.query}
        aria-label={t('reviewer.model.search')}
        placeholder={t('reviewer.model.searchPlaceholder')}
        onChange={(event) => {
          props.onQuery(event.target.value);
        }}
        className={inputClassName}
      />
      <select
        aria-label={t('reviewer.model.label')}
        value={encodeChoice(choice)}
        onChange={(event) => {
          const value = event.target.value;
          // The session route is not a catalog entry, and the pinned current
          // route is not in the filtered list when it is hidden or unlisted;
          // both are real choices of this control and must not be dropped.
          if (value === encodeChoice(SESSION_CHOICE)) {
            props.onChoice(SESSION_CHOICE);
            return;
          }
          if (value === encodeChoice(choice)) {
            props.onChoice(choice);
            return;
          }
          const selected = options.find(
            (option) => encodeChoice(option) === value,
          );
          if (selected === undefined) return;
          props.onChoice({
            provider: selected.provider,
            model: selected.model,
          });
        }}
        className={inputClassName}
      >
        <option value={encodeChoice(SESSION_CHOICE)}>
          {t('reviewer.model.session')}
        </option>
        {!sessionChosen && !visible ? (
          <option value={encodeChoice(choice)}>
            {currentLabel(catalog, choice, unlisted)}
          </option>
        ) : null}
        {groups.map((group) => (
          <optgroup
            key={group.id}
            label={
              ambiguous.has(group.name)
                ? `${group.name}（${group.id}）`
                : group.name
            }
          >
            {group.models.map((model) => (
              <option
                key={`${group.id}\u0000${model.id}`}
                value={encodeChoice({ provider: group.id, model: model.id })}
              >
                {optionLabel(group, model.id, model.name, ambiguous)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <CatalogStatus
        catalog={catalog}
        status={status}
        optionCount={options.length}
        entry={catalogueEntry(catalog, choice, visible)}
      />
    </div>
  );
}

/**
 * Where the draft route stands relative to the full catalogue.
 *
 * `filtered` is not `unlisted`: the route still exists, the search simply hides
 * it. Keeping those apart stops a search from being reported as a removed
 * model, and the selected option stays in the list either way.
 */
type CatalogEntry = 'session' | 'visible' | 'filtered' | 'unlisted';

function catalogueEntry(
  catalog: ModelCatalogView | null,
  choice: ModelChoice,
  visible: boolean,
): CatalogEntry {
  if (isSessionChoice(choice)) return 'session';
  if (catalog === null || !choiceInGroups(catalog.groups, choice))
    return 'unlisted';
  return visible ? 'visible' : 'filtered';
}

/** Loading, empty, filtered-empty, unlisted and per-provider failure text. */
function CatalogStatus(props: {
  readonly catalog: ModelCatalogView | null;
  readonly status: CatalogLoad;
  readonly optionCount: number;
  readonly entry: CatalogEntry;
}): ReactNode {
  const t = useArbiterTranslation();
  const { catalog, status } = props;
  if (status === 'loading') {
    return (
      <span className="arb:text-[11.5px] arb:text-tertiary">
        {t('reviewer.model.loading')}
      </span>
    );
  }
  if (status === 'failed' || catalog === null) {
    return (
      <span role="status" className="arb:text-[11.5px] arb:text-tertiary">
        {t('reviewer.model.failed')}
      </span>
    );
  }
  return (
    <div className="arb:flex arb:flex-col arb:gap-0.5">
      {catalog.supported ? null : (
        <span className="arb:text-[11.5px] arb:text-tertiary">
          {t('reviewer.model.unsupported')}
        </span>
      )}
      {catalog.supported && catalog.groups.length === 0 ? (
        <span className="arb:text-[11.5px] arb:text-tertiary">
          {t('reviewer.model.empty')}
        </span>
      ) : null}
      {catalog.groups.length > 0 && props.optionCount === 0 ? (
        <span className="arb:text-[11.5px] arb:text-tertiary">
          {t('reviewer.model.noMatch')}
        </span>
      ) : null}
      {props.entry === 'unlisted' ? (
        <span className="arb:text-[11.5px] arb:text-tertiary">
          {t('reviewer.model.notInCatalog')}
        </span>
      ) : null}
      {props.entry === 'filtered' ? (
        <span role="status" className="arb:text-[11.5px] arb:text-tertiary">
          {t('reviewer.model.filteredOut')}
        </span>
      ) : null}
      {catalog.failures.map((failure) => (
        <span key={failure.id} className="arb:text-[11.5px] arb:text-tertiary">
          {t('reviewer.model.providerFailed', { provider: failure.name })}
        </span>
      ))}
    </div>
  );
}
