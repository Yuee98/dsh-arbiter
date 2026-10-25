import { CONTROL_OPERATORS, REDIRECT_OPERATORS } from './constants.js';
import type {
  OperatorToken,
  RedirectToken,
  Token,
  WordToken,
} from './types.js';
import { readWord } from './words.js';

function operatorToken(value: string, start: number): OperatorToken {
  return {
    kind: 'op',
    value,
    raw: value,
    start,
    end: start + value.length,
    unresolved: [],
    substitutions: 0,
  };
}

function descriptorPrefix(
  source: string,
  index: number,
): { fd: string | null; redirectStart: number } {
  let digitEnd = index;
  for (;;) {
    const digit = source[digitEnd];
    if (digit === undefined || digit < '0' || digit > '9') break;
    digitEnd += 1;
  }
  const operator = REDIRECT_OPERATORS.find((candidate) =>
    source.startsWith(candidate, digitEnd),
  );
  if (digitEnd > index && operator !== undefined) {
    return { fd: source.slice(index, digitEnd), redirectStart: digitEnd };
  }
  return { fd: null, redirectStart: index };
}

function redirectToken(source: string, index: number): RedirectToken | null {
  const { fd, redirectStart } = descriptorPrefix(source, index);
  const redirect = REDIRECT_OPERATORS.find((candidate) =>
    source.startsWith(candidate, redirectStart),
  );
  if (redirect === undefined) return null;
  let cursor = redirectStart + redirect.length;
  while (source[cursor] === ' ' || source[cursor] === '\t') cursor += 1;
  let target = '';
  const unresolved: string[] = [];
  if (cursor < source.length && !';&|(){}<>'.includes(source[cursor] ?? '')) {
    const word = readWord(source, cursor);
    target = word.value;
    unresolved.push(...word.unresolved);
    cursor = word.end;
  }
  return {
    kind: 'redirect',
    value: redirect,
    fd,
    target,
    raw: source.slice(index, cursor),
    start: index,
    end: cursor,
    unresolved,
  };
}

function wordToken(source: string, index: number): WordToken {
  const word = readWord(source, index);
  if (word.end === index) {
    return {
      kind: 'word',
      value: source[index] ?? '',
      raw: source[index] ?? '',
      start: index,
      end: index + 1,
      unresolved: [],
      substitutions: 0,
      quoted: false,
    };
  }
  return { kind: 'word', ...word, start: index };
}

export interface TokenizedShell {
  readonly tokens: Token[];
  readonly heredocs: number;
  readonly comments: string[];
}

function whitespaceEnd(source: string, index: number): number | null {
  const char = source[index];
  if (char === ' ' || char === '\t' || char === '\r') return index + 1;
  if (char === '\\' && source[index + 1] === '\n') return index + 2;
  return null;
}

export function tokenize(source: string): TokenizedShell {
  const tokens: Token[] = [];
  const comments: string[] = [];
  let index = 0;
  let heredocs = 0;
  while (index < source.length) {
    const char = source[index] ?? '';
    const afterWhitespace = whitespaceEnd(source, index);
    if (afterWhitespace !== null) {
      index = afterWhitespace;
      continue;
    }
    if (char === '\n') {
      tokens.push(operatorToken('\n', index));
      index += 1;
      continue;
    }
    const commentBoundary =
      index === 0 || /[\s;&|(){}]/u.test(source[index - 1] ?? '');
    if (char === '#' && commentBoundary) {
      const end = source.indexOf('\n', index);
      comments.push(source.slice(index, end === -1 ? source.length : end));
      index = end === -1 ? source.length : end;
      continue;
    }
    const redirect = redirectToken(source, index);
    if (redirect !== null) {
      if (redirect.value === '<<' || redirect.value === '<<-') heredocs += 1;
      tokens.push(redirect);
      index = redirect.end;
      continue;
    }
    const operator = CONTROL_OPERATORS.find((candidate) =>
      source.startsWith(candidate, index),
    );
    if (operator !== undefined) {
      tokens.push(operatorToken(operator, index));
      index += operator.length;
      continue;
    }
    const word = wordToken(source, index);
    tokens.push(word);
    index = word.end;
  }
  return { tokens, heredocs, comments };
}
