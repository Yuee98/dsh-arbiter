import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';

/** A bootstrap token is local and short-lived, but should not enter artifacts. */
export function redactHostLog(text: string): string {
  return text.replace(/([?&]token=)[^\s&]+/g, '$1<redacted>');
}

export interface HostProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<string>;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

export function launchHost(
  executable: string,
  profile: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
): HostProcess {
  const child = spawn(
    executable,
    ['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'],
    {
      cwd: workspace,
      env,
      stdio: 'pipe',
      detached: process.platform !== 'win32',
    },
  );
  child.stdin.end();
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const ready = new Promise<string>((resolveReady, rejectReady) => {
    const finish = (error?: Error, url?: string): void => {
      clearTimeout(timer);
      child.stdout.off('data', check);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error !== undefined) rejectReady(error);
      else if (url !== undefined) resolveReady(url);
    };
    const check = (): void => {
      const greeting = stdout.match(/^dsh web: (https?:\/\/\S+)\s*$/m)?.[1];
      if (greeting !== undefined) finish(undefined, greeting);
    };
    const onError = (error: Error): void => {
      finish(error);
    };
    const onExit = (code: number | null, signal: string | null): void => {
      finish(
        new Error(
          `DSH exited before ready (${String(code ?? signal)}).\n${redactHostLog(stderr).slice(-4000)}`,
        ),
      );
    };
    const timer = setTimeout(() => {
      finish(
        new Error(
          `DSH did not start within 60 seconds.\n${redactHostLog(stderr).slice(-4000)}`,
        ),
      );
    }, 60_000);
    child.stdout.on('data', check);
    child.once('error', onError);
    child.once('exit', onExit);
  });
  return { child, ready, stdout: () => stdout, stderr: () => stderr };
}

function signalGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ESRCH'
    )
      return;
    throw error;
  }
}

/** Wait for exit, then forcibly clean up this fixture's process group only. */
export async function stopHost(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.pid === undefined) return;
  const hasExited = (): boolean =>
    child.exitCode !== null || child.signalCode !== null;
  if (hasExited()) return;
  const exited = once(child, 'exit');
  signalGroup(child, 'SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    exited,
    new Promise<void>((resolveTimeout) => {
      timer = setTimeout(resolveTimeout, 5000);
    }),
  ]);
  clearTimeout(timer);
  if (!hasExited()) {
    signalGroup(child, 'SIGKILL');
    await exited;
  }
}
