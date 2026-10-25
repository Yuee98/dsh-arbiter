import { testRules } from '../rules/match.js';
import { executionModeName } from './common.js';
import type { HostEnvironment } from './types.js';

export function registerCommands(host: HostEnvironment): void {
  const { ctx, runtime, audit } = host;
  const commands = host.services.commands;
  const invalidConfigError = runtime.invalidConfigError;
  if (commands !== undefined) {
    try {
      commands.register({
        name: 'arbiter',
        description: 'dsh-arbiter status and rule test',
        input: { hint: 'status | test <command>' },
        handler: ({ rawInput }) => {
          const trimmed = rawInput.trim();
          if (trimmed.startsWith('test')) {
            const input = trimmed.slice('test'.length).trim();
            if (input.length === 0) {
              return {
                kind: 'error' as const,
                text: 'usage: /arbiter test <command>',
              };
            }
            const result = testRules(input, runtime.config.rules, {
              identity: 'main',
              workspaceRoot: process.cwd(),
              cwd: process.cwd(),
            });
            return {
              kind: 'success' as const,
              text: `${result.path}${result.rule === null ? '' : ` (${result.rule.id})`}`,
            };
          }
          if (trimmed.startsWith('mode')) {
            const target = trimmed.slice('mode'.length).trim();
            if (target !== 'trusted' && target !== 'guarded') {
              return {
                kind: 'error' as const,
                text: 'usage: /arbiter mode trusted|guarded',
              };
            }
            // The old entry applied the host's `auto` preset for trusted,
            // which is now rejected. Report the removal instead of silently
            // writing a permission the user did not ask for.
            if (target === 'trusted') {
              return {
                kind: 'error' as const,
                text: [
                  'arbiter: /arbiter mode trusted was removed.',
                  'trusted / guarded are chosen on the arbiter config page and applied through the session permission menu entry "自动审查（Arbiter）".',
                  'The native auto preset is not supported by Arbiter.',
                ].join('\n'),
              };
            }
            return {
              kind: 'error' as const,
              text: [
                'arbiter: /arbiter mode was removed.',
                'trusted / guarded are chosen on the arbiter config page and applied through the session permission menu entry "自动审查（Arbiter）".',
              ].join('\n'),
            };
          }
          const main = runtime.config.modes.main;
          const sub = runtime.config.modes.subagent;
          return {
            kind: 'success' as const,
            text: [
              `arbiter ${runtime.config.enabled ? 'enabled' : 'disabled'} · revision ${runtime.effectiveRevision}`,
              `main=${main} subagent=${sub} execution=${executionModeName(ctx)}`,
              `rules=${String(runtime.config.rules.length)} reviewer=${runtime.config.reviewer.type}`,
              `audit=${audit === null ? 'unavailable' : audit.health().state}`,
              ...(invalidConfigError === null
                ? []
                : [`config error: ${invalidConfigError}`]),
            ].join('\n'),
          };
        },
      });
    } catch (error) {
      ctx.logger.warn('arbiter: command registration skipped: %s', error);
    }
  }
}
