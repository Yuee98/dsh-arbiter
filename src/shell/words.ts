/** Static shell-word reading; expansions are recorded without evaluation. */
export interface ReadWord {
  readonly value: string;
  readonly raw: string;
  readonly end: number;
  readonly unresolved: string[];
  readonly substitutions: number;
  readonly quoted: boolean;
}

class WordReader {
  private index: number;
  private value = '';
  private quoted = false;
  private readonly unresolved: string[] = [];
  private substitutions = 0;

  private readonly source: string;
  private readonly start: number;

  constructor(source: string, start: number) {
    this.source = source;
    this.start = start;
    this.index = start;
  }

  private readBalanced(open: string, close: string): string {
    let depth = 1;
    this.index += 1;
    const bodyStart = this.index;
    while (this.index < this.source.length && depth > 0) {
      const char = this.source[this.index];
      if (char === '\\') {
        this.index += 2;
        continue;
      }
      if (char === open) depth += 1;
      else if (char === close) depth -= 1;
      this.index += 1;
    }
    return this.source.slice(bodyStart, Math.max(bodyStart, this.index - 1));
  }

  private readDollar(): void {
    const dollar = this.index;
    this.index += 1;
    if (this.source[this.index] === '(') {
      const body = this.readBalanced('(', ')');
      const expansion = `$(${body})`;
      this.value += expansion;
      this.unresolved.push(expansion);
      this.substitutions += 1;
      return;
    }
    if (this.source[this.index] === '{') {
      const body = this.readBalanced('{', '}');
      const expansion = `\${${body}}`;
      this.value += expansion;
      this.unresolved.push(expansion);
      return;
    }
    const nameStart = this.index;
    while (
      this.index < this.source.length &&
      /[A-Za-z0-9_@*#?$!-]/u.test(this.source[this.index] ?? '')
    ) {
      this.index += 1;
    }
    if (this.index === nameStart) {
      this.value += '$';
      return;
    }
    const expansion = this.source.slice(dollar, this.index);
    this.value += expansion;
    this.unresolved.push(expansion);
  }

  private readBacktick(): void {
    const close = this.source.indexOf('`', this.index + 1);
    const end = close === -1 ? this.source.length : close;
    const body = this.source.slice(this.index + 1, end);
    this.value += `\`${body}\``;
    this.unresolved.push(`\`${body}\``);
    this.substitutions += 1;
    this.index = end + 1;
  }

  private readEscaped(): void {
    const next = this.source[this.index + 1];
    if (next === '\n') {
      this.index += 2;
      return;
    }
    this.value += next ?? '';
    this.index += next === undefined ? 1 : 2;
    this.quoted = true;
  }

  private readSingleQuoted(): void {
    this.quoted = true;
    this.index += 1;
    while (this.index < this.source.length && this.source[this.index] !== "'") {
      this.value += this.source[this.index] ?? '';
      this.index += 1;
    }
    if (this.source[this.index] === "'") this.index += 1;
  }

  private readDoubleQuoted(): void {
    this.quoted = true;
    this.index += 1;
    while (this.index < this.source.length && this.source[this.index] !== '"') {
      const inner = this.source[this.index] ?? '';
      if (inner === '\\') {
        const next = this.source[this.index + 1];
        if (next !== undefined && '"\\$`'.includes(next)) {
          this.value += next;
          this.index += 2;
          continue;
        }
        this.value += inner;
        this.index += 1;
        continue;
      }
      if (inner === '$') this.readDollar();
      else if (inner === '`') this.readBacktick();
      else {
        this.value += inner;
        this.index += 1;
      }
    }
    if (this.source[this.index] === '"') this.index += 1;
  }

  read(): ReadWord {
    while (this.index < this.source.length) {
      const char = this.source[this.index] ?? '';
      if (
        char === ' ' ||
        char === '\t' ||
        char === '\n' ||
        ';&|(){}<>'.includes(char)
      )
        break;
      if (char === '\\') this.readEscaped();
      else if (char === "'") this.readSingleQuoted();
      else if (char === '"') this.readDoubleQuoted();
      else if (char === '$') this.readDollar();
      else if (char === '`') this.readBacktick();
      else {
        this.value += char;
        this.index += 1;
      }
    }
    return {
      value: this.value,
      raw: this.source.slice(this.start, this.index),
      end: this.index,
      unresolved: this.unresolved,
      substitutions: this.substitutions,
      quoted: this.quoted,
    };
  }
}

export function readWord(source: string, start: number): ReadWord {
  return new WordReader(source, start).read();
}
