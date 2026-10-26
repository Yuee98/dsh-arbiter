/**
 * Static word values and their canonical matching text.
 *
 * A word is *static* only when every part decodes to a literal character that
 * the shell would keep: literals, single quotes, double quotes built from
 * literals, and ANSI-C quotes whose decoded value is representable. Anything
 * else keeps its raw source text and records why, so a rule can still match what
 * the user actually wrote and the caller never has to guess an expansion.
 *
 * This module never reads the environment, runs a command, expands a glob or a
 * brace, or resolves a tilde: the only values it produces are the characters
 * that are already in the command text.
 */

import type { WordPart } from 'unbash';
import { quoteStaticWord } from './quote.js';
import type { ShellWord } from './types.js';

/** Why a word could not be decoded, in a stable machine-readable form. */
const REASON_VARIABLE = 'variable';
const REASON_COMMAND_SUBSTITUTION = 'command-substitution';
const REASON_ARITHMETIC = 'arithmetic-expansion';
const REASON_PROCESS_SUBSTITUTION = 'process-substitution';
const REASON_GLOB = 'glob';
const REASON_BRACE = 'brace-expansion';
const REASON_EXTGLOB = 'extended-glob';
const REASON_TILDE = 'tilde';
const REASON_LOCALE = 'locale-string';
const REASON_NUL = 'nul-byte';
const REASON_LOSSY = 'lossy-byte';

interface WordReading {
  readonly value: string;
  readonly reasons: readonly string[];
}

/** Resolve the backslash escapes a bare word carries; no expansion involved. */
function unescapeBare(text: string): string {
  if (!text.includes('\\')) return text;
  let value = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? '';
    if (char !== '\\') {
      value += char;
      index += 1;
      continue;
    }
    const next = text[index + 1];
    if (next === undefined) {
      // A trailing backslash is not a complete escape; keep it verbatim.
      value += char;
      index += 1;
      continue;
    }
    if (next === '\n') {
      index += 2;
      continue;
    }
    value += next;
    index += 2;
  }
  return value;
}

/** The reason a non-literal part makes its whole word dynamic. */
const DYNAMIC_REASONS: Partial<Record<WordPart['type'], string>> = {
  // `$"..."` depends on the active locale catalog; the text is kept.
  LocaleString: REASON_LOCALE,
  SimpleExpansion: REASON_VARIABLE,
  ParameterExpansion: REASON_VARIABLE,
  CommandExpansion: REASON_COMMAND_SUBSTITUTION,
  ArithmeticExpansion: REASON_ARITHMETIC,
  ProcessSubstitution: REASON_PROCESS_SUBSTITUTION,
  Glob: REASON_GLOB,
  BraceExpansion: REASON_BRACE,
  ExtendedGlob: REASON_EXTGLOB,
};

/** The reason a part makes its whole word dynamic, or null when it is literal. */
function dynamicReason(part: WordPart): string | null {
  return DYNAMIC_REASONS[part.type] ?? null;
}

/** The decoded text of an ANSI-C quote, or a reason it cannot be trusted. */
function ansiCValue(part: WordPart & { readonly type: 'AnsiCQuoted' }): {
  readonly value: string;
  readonly reason: string | null;
} {
  // A NUL cannot travel through a text command line, and invalid UTF-8 was
  // replaced with U+FFFD while decoding; neither value is the real word.
  if (part.value.includes('\u0000')) return { value: '', reason: REASON_NUL };
  if (part.value.includes('\uFFFD')) return { value: '', reason: REASON_LOSSY };
  return { value: part.value, reason: null };
}

/** Decode one part tree without following any expansion. */
function readParts(
  parts: readonly WordPart[],
  reasons: string[],
  nested: string[],
): string {
  let value = '';
  for (const part of parts) {
    if (part.type === 'Literal' || part.type === 'SingleQuoted') {
      value += part.value;
      continue;
    }
    if (part.type === 'DoubleQuoted') {
      value += readParts(part.parts, reasons, nested);
      continue;
    }
    if (part.type === 'AnsiCQuoted') {
      const decoded = ansiCValue(part);
      if (decoded.reason !== null) {
        reasons.push(decoded.reason);
        nested.push(part.text);
      } else {
        value += decoded.value;
      }
      continue;
    }
    const reason = dynamicReason(part);
    if (reason !== null) {
      reasons.push(reason);
      nested.push(part.text);
    }
  }
  return value;
}

/**
 * Read one word.
 *
 * `parts` is absent for a word the lexer never split (a bare word); its decoded
 * value is then the source text with backslash escapes resolved, which is still
 * static because a bare word cannot contain an expansion without parts.
 */
function readWord(
  text: string,
  parts: readonly WordPart[] | undefined,
): WordReading {
  if (parts === undefined) {
    const value = unescapeBare(text);
    return {
      value,
      reasons: value.startsWith('~') ? [REASON_TILDE] : [],
    };
  }
  const reasons: string[] = [];
  const nested: string[] = [];
  const value = readParts(parts, reasons, nested);
  // An unquoted leading tilde is a home-directory expansion decided at run time,
  // even when every part is literal. A quoted or `~user` form is not expanded by
  // the shell the same way, so only the plain leading tilde is treated this way.
  if (reasons.length === 0 && /^~(?:\/|$)/u.test(text))
    reasons.push(REASON_TILDE);
  return { value, reasons };
}

/** A word kept exactly as written, with every reason it could not be decoded. */
function dynamicWord(
  text: string,
  reasons: readonly string[],
  unresolved: readonly string[],
): ShellWord {
  return { raw: text, text, status: 'dynamic', reasons, unresolved };
}

/**
 * Turn one source word into its matching text.
 *
 * Static words are rendered in one canonical single-quote form, so argument
 * boundaries survive; dynamic words keep the original expression so distinct
 * forms such as `'$HOME'`, `"$HOME"` and `$HOME` are never conflated.
 */
export function readShellWord(
  text: string,
  parts: readonly WordPart[] | undefined,
): ShellWord {
  const reading = readWord(text, parts);
  if (reading.reasons.length > 0) {
    return dynamicWord(text, reading.reasons, [text]);
  }
  return {
    raw: text,
    text: quoteStaticWord(reading.value),
    value: reading.value,
    status: 'static',
    reasons: [],
    unresolved: [],
  };
}
