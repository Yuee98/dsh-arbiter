/** Reserved words and external runtimes the facts layer reports without executing. */

export const INTERPRETERS = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'python',
  'python3',
  'node',
  'bun',
  'deno',
  'ruby',
  'perl',
  'php',
  'lua',
  'osascript',
  'powershell',
  'pwsh',
]);

export const SCRIPT_SUFFIXES = [
  '.sh',
  '.bash',
  '.zsh',
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.rb',
  '.pl',
  '.php',
  '.lua',
  '.ps1',
] as const;

export const NETWORK_COMMANDS = new Set([
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'telnet',
  'http',
  'https',
  'xh',
  'aria2c',
]);

export const CREDENTIAL_HINTS = [
  '.env',
  '.ssh/',
  'id_rsa',
  'id_ed25519',
  '.aws/credentials',
  '.netrc',
  'credentials.json',
  '.pem',
  'token',
  'secret',
  'password',
];
