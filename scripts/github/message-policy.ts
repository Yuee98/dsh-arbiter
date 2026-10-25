const types = [
  'feat',
  'fix',
  'refactor',
  'perf',
  'docs',
  'test',
  'build',
  'ci',
  'chore',
  'style',
  'revert',
];

const header = new RegExp(
  `^(?:${types.join('|')})(?:\\([a-z0-9]+(?:[./_-][a-z0-9]+)*\\))?!?: [!-~](?:[ -~]*[!-~])?$`,
  'u',
);

export function assertMessageTitle(title: string): void {
  if (!/^[\x20-\x7e]+$/u.test(title) || !header.test(title)) {
    throw new Error(
      `Use type(scope)!: summary with printable ASCII and no surrounding whitespace. Scope and ! are optional. Types: ${types.join(', ')}. Example: ci: validate PR titles`,
    );
  }
}

export function assertMessageBody(body: string): void {
  if (!/^[\t\n\x20-\x7e]*$/u.test(body)) {
    throw new Error(
      'Squash body must be empty or English printable ASCII (tabs and LF line breaks are allowed). PR descriptions may remain Chinese.',
    );
  }
}
