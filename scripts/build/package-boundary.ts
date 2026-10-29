/**
 * What may not reach the published package.
 *
 * The evals subproject is engineering machinery, not part of the plugin: it carries
 * an annotation workflow and, eventually, dataset material that has no business in a
 * user's install. Two things therefore have to stay out of the tarball, and both are
 * checked on the artifact rather than on intent:
 *
 *   - no `evals/` path in the file list the packer actually produced, because the
 *     `files` field is an input to the packer and not a guarantee about its output;
 *   - no import of an evals module from any emitted JavaScript, because a build step
 *     could otherwise inline one without adding a file.
 *
 * Reading the emitted code is what makes the second check a check on the artifact. A
 * source scan would pass while the built file still reached into evals.
 */

/** Repository-relative prefixes that must never appear in the published tarball. */
export const FORBIDDEN_PREFIXES = ['evals/'] as const;

/**
 * The tarball entries that must not have been published.
 *
 * `tar tzf` lists entries as `package/<path>`, so the prefix is added here rather
 * than being matched loosely: a project file that happens to mention "evals" must
 * not trip the check.
 */
export function forbiddenEntries(listing: string): readonly string[] {
  const entries = listing.split('\n').filter((entry) => entry !== '');
  return entries.filter((entry) =>
    FORBIDDEN_PREFIXES.some((prefix) => entry.startsWith(`package/${prefix}`)),
  );
}

/** Import, re-export and dynamic-import specifiers that point into evals. */
export function evalsSpecifiers(text: string): readonly string[] {
  const pattern =
    /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/gu;
  const specifiers: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined && /(^|\/)evals(\/|$)/u.test(specifier)) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}
