/**
 * dsh-arbiter configuration page.
 *
 * The page is a projection of the host's effective configuration, audit store
 * and offline candidate table. All writes go through the host's exact Fetch
 * routes, which validate the complete candidate, fence concurrent file edits
 * and persist through the profile's config editor.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';

import { ApiError, getJson, postJson } from './api.js';
import type {
  ArbiterConfig,
  CommandRule,
  ConfigError,
  ConfigWarning,
  RuleKind,
  RuleNode,
  RuleTestResult,
  RuleVerdict,
} from '../types.js';

type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer U)[]
    ? Mutable<U>[]
    : T[K] extends object
      ? Mutable<T[K]>
      : T[K];
};

type Draft = Mutable<ArbiterConfig>;
type DraftRule = Mutable<CommandRule>;

interface AuditHealthView {
  readonly state: 'ok' | 'degraded' | 'unavailable' | 'disabled';
  readonly lastError: string | null;
  readonly dropped: number;
  readonly pending: number;
}

interface AuditStats {
  readonly calls: number;
  readonly modelCalls: number;
  readonly bytes: number;
  readonly results: readonly {
    readonly result: string;
    readonly count: number;
  }[];
}

interface StateResponse {
  readonly name: string;
  readonly enabled: boolean;
  readonly config: ArbiterConfig;
  readonly sourceConfig: unknown;
  readonly effectiveRevision: string;
  readonly configSnapshotId: string;
  readonly fileRevision: string | null;
  readonly documentPath: string | null;
  readonly invalidConfigError: string | null;
  readonly loadErrors: readonly ConfigError[];
  readonly warnings: readonly ConfigWarning[];
  readonly autoPresetError: string | null;
  readonly configHistory: readonly {
    readonly id: string;
    readonly activatedAt: number;
    readonly revision: string;
    readonly entry: string;
    readonly scope: string;
    readonly snapshotId: string;
  }[];
  readonly audit: {
    readonly health: AuditHealthView;
    readonly path: string | null;
    readonly bytes: number;
    readonly stats: AuditStats | null;
  };
  readonly coverage: {
    readonly gated: readonly string[];
    readonly notGated: readonly string[];
  };
  readonly policyVersion: string;
  readonly modes: { readonly main: string; readonly subagent: string };
  readonly executionMode: string;
  readonly reviewerType: string;
  readonly sessionRecordErrors: readonly (readonly [string, string])[];
}

interface LogRow {
  readonly callId: string;
  readonly ts: number;
  readonly sessionId: string;
  readonly sessionKind: string;
  readonly tool: string;
  readonly command: string;
  readonly result: string;
  readonly reason: string;
  readonly ruleId: string | null;
  readonly approvalMode: string;
  readonly decisionRules: readonly string[];
}

interface LogDetail {
  readonly callId: string;
  readonly ts: number;
  readonly sessionId: string;
  readonly sessionKind: string;
  readonly parentSession: string | null;
  readonly tool: string;
  readonly arguments: unknown;
  readonly cwd: string;
  readonly fingerprint: string;
  readonly configRevision: string;
  readonly approvalMode: string;
  readonly executionMode: string;
  readonly result: string;
  readonly reason: string;
  readonly trace: readonly unknown[];
  readonly effect: unknown;
  readonly sessionRecordState: string;
  readonly signals: unknown;
  readonly policyStrategy: string | null;
  readonly decisionRules: readonly string[];
  readonly executionStatus: string;
  readonly stages: readonly {
    readonly seq: number;
    readonly stage: string;
    readonly result: string;
    readonly reason: string | null;
    readonly ruleId: string | null;
    readonly decisionRules: readonly string[];
    readonly configRevision: string | null;
    readonly ts: number;
  }[];
  readonly snapshot: unknown;
  readonly modelCalls: readonly {
    readonly requestId: string;
    readonly attempt: number;
    readonly backend: string;
    readonly protocol: string;
    readonly request: unknown;
    readonly responseText: string | null;
    readonly parsed: unknown;
    readonly error: string | null;
    readonly startedAt: number;
    readonly durationMs: number;
    readonly estimatedInputTokens: number;
    readonly usage: unknown;
  }[];
  readonly config: unknown;
}

interface CandidateView {
  readonly candidateId: string;
  readonly createdAt: number;
  readonly status: 'pending' | 'accepted' | 'rejected';
  readonly rule: unknown;
  readonly stats: unknown;
  readonly evidence: unknown;
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly note: string | null;
}

interface ReplayView {
  readonly considered: number;
  readonly comparable: number;
  readonly promoted: number;
  readonly normalAllow: number;
  readonly progressAllow: number;
  readonly changed: number;
  readonly skipped: number;
  readonly items: readonly {
    readonly callId: string;
    readonly tool: string;
    readonly normal: string;
    readonly progress: string;
    readonly promoted: boolean;
  }[];
}

interface SlotProps {
  readonly view?: string;
}

interface ClientContext {
  readonly slots: {
    inject(name: string, callback: () => unknown): void;
    register(
      options: { readonly name: string; readonly key?: string },
      component: ComponentType<SlotProps>,
    ): unknown;
  };
}

const MODE_HELP: Record<string, string> = {
  normal:
    '按命令规则处理，对需要审查的调用进行自动审查，并按策略自动批准或拒绝；需要人工决定时发起审批。',
  strict:
    '使用与交互审批相同的审查标准；需要人工审批的调用不执行，不新发起审批。Agent 仍可通过 ask 或聊天提问。',
  progress:
    '在常规策略基础上调整部分条件和阈值，自动批准更多符合条件的操作；仍需人工审批的调用不执行。',
};

const VERDICTS: readonly RuleVerdict[] = [
  'allow',
  'deny',
  'force-ask',
  'force-review',
];
const NODES: readonly RuleNode[] = [
  'command',
  'file_redirect',
  'variable_assignment',
  'tool',
];
const KINDS: readonly RuleKind[] = ['exact', 'regex', 'glob'];

const TABS = [
  ['status', '状态与模式'],
  ['rules', '规则'],
  ['reviewer', 'Reviewer'],
  ['advanced', '策略与高级'],
  ['logs', '日志与详情'],
  ['suggestions', '离线建议'],
  ['about', '覆盖与试用'],
] as const;

type TabId = (typeof TABS)[number][0];

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const payload = error.payload;
    if (
      payload !== null &&
      typeof payload === 'object' &&
      'errors' in payload
    ) {
      const errors =
        (payload as { readonly errors?: readonly ConfigError[] }).errors ?? [];
      if (errors.length > 0) {
        return `${error.message}: ${errors.map((item) => `${item.path} ${item.message}`).join('; ')}`;
      }
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function formatTime(ts: number): string {
  if (ts === 0) return '—';
  return new Date(ts).toLocaleString();
}

function cloneDraft(config: ArbiterConfig): Draft {
  const value: Draft = JSON.parse(JSON.stringify(config));
  return value;
}

function Section(props: {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        marginBottom: 24,
      }}
    >
      <div>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
          {props.title}
        </h3>
        {props.description === undefined ? null : (
          <p
            style={{
              margin: '4px 0 0',
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: 12.5,
            }}
          >
            {props.description}
          </p>
        )}
      </div>
      {props.children}
    </section>
  );
}

function Field(props: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <label
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        fontSize: 12.5,
      }}
    >
      <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>
        {props.label}
      </span>
      {props.children}
      {props.hint === undefined ? null : (
        <span
          style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 11.5 }}
        >
          {props.hint}
        </span>
      )}
    </label>
  );
}

const inputStyle = {
  boxSizing: 'border-box' as const,
  height: 30,
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-layer-3)',
  color: 'var(--dsw-alias-label-primary)',
  padding: '0 8px',
  fontSize: 12.5,
  width: '100%',
};

function TextInput(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly monospace?: boolean;
}): ReactNode {
  return (
    <input
      type="text"
      value={props.value}
      placeholder={props.placeholder}
      onChange={(event) => props.onChange(event.target.value)}
      style={{
        ...inputStyle,
        fontFamily:
          props.monospace === true
            ? 'var(--dsw-font-mono, monospace)'
            : undefined,
      }}
    />
  );
}

function NumberInput(props: {
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}): ReactNode {
  return (
    <input
      type="number"
      value={props.value}
      min={props.min}
      max={props.max}
      step={props.step ?? 1}
      onChange={(event) => {
        const next = Number(event.target.value);
        if (Number.isFinite(next)) props.onChange(next);
      }}
      style={inputStyle}
    />
  );
}

function Select<T extends string>(props: {
  readonly value: string;
  readonly options: readonly T[];
  readonly labels?: Readonly<Record<string, string>>;
  readonly onChange: (value: T) => void;
}): ReactNode {
  return (
    <select
      value={props.value}
      onChange={(event) => props.onChange(event.target.value as T)}
      style={inputStyle}
    >
      {props.options.map((option) => (
        <option key={option} value={option}>
          {props.labels?.[option] ?? option}
        </option>
      ))}
    </select>
  );
}

function Button(props: {
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly tone?: 'primary' | 'danger' | 'plain';
}): ReactNode {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      style={{
        height: 30,
        padding: '0 12px',
        borderRadius: 6,
        cursor: props.disabled === true ? 'default' : 'pointer',
        opacity: props.disabled === true ? 0.5 : 1,
        fontSize: 12.5,
        border:
          props.tone === 'primary'
            ? '0.5px solid var(--dsw-alias-state-business-primary)'
            : '0.5px solid var(--dsw-alias-border-l4)',
        background:
          props.tone === 'primary'
            ? 'var(--dsw-alias-state-business-primary)'
            : props.tone === 'danger'
              ? 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)'
              : 'var(--dsw-alias-bg-layer-3)',
        color:
          props.tone === 'primary'
            ? 'var(--dsw-alias-label-primary-foreground, white)'
            : props.tone === 'danger'
              ? 'var(--dsw-alias-state-error-primary)'
              : 'var(--dsw-alias-label-primary)',
      }}
    >
      {props.children}
    </button>
  );
}

function Notice(props: {
  readonly kind: 'ok' | 'error' | 'info';
  readonly text: string;
}): ReactNode {
  const color =
    props.kind === 'error'
      ? 'var(--dsw-alias-state-error-primary)'
      : props.kind === 'ok'
        ? 'var(--dsw-alias-state-success-primary)'
        : 'var(--dsw-alias-label-secondary)';
  return (
    <div
      role="status"
      style={{
        border: `0.5px solid ${color}`,
        borderRadius: 6,
        padding: '8px 10px',
        fontSize: 12.5,
        color,
        whiteSpace: 'pre-wrap',
      }}
    >
      {props.text}
    </div>
  );
}

function JsonBlock(props: { readonly value: unknown }): ReactNode {
  return (
    <pre
      style={{
        margin: 0,
        padding: 10,
        maxHeight: 360,
        overflow: 'auto',
        background: 'var(--dsw-alias-bg-module-platform)',
        borderRadius: 6,
        fontSize: 11.5,
        fontFamily: 'var(--dsw-font-mono, monospace)',
        whiteSpace: 'pre-wrap',
      }}
    >
      {JSON.stringify(props.value, null, 2)}
    </pre>
  );
}

function StatusPanel(props: {
  readonly state: StateResponse;
  readonly draft: Draft;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
}): ReactNode {
  const { state, draft, onDraft } = props;
  return (
    <>
      <Section
        title="启用与审批模式"
        description="审批模式只控制插件是否发起人工审批，不限制 agent 使用 ask 或聊天。"
      >
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 13,
          }}
        >
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) =>
              onDraft((next) => {
                next.enabled = event.target.checked;
              })
            }
          />
          启用 dsh-arbiter
        </label>
        <div
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}
        >
          <Field
            label="主会话审批模式"
            hint={MODE_HELP[draft.modes.main] ?? '—'}
          >
            <Select
              value={draft.modes.main}
              options={['normal', 'strict', 'progress'] as const}
              labels={{
                normal: '交互审批',
                strict: '自动审批',
                progress: '自动审批 · 推进',
              }}
              onChange={(value) =>
                onDraft((next) => {
                  next.modes.main = value;
                })
              }
            />
          </Field>
          <Field
            label="子任务审批模式"
            hint={MODE_HELP[draft.modes.subagent] ?? '—'}
          >
            <Select
              value={draft.modes.subagent}
              options={['strict', 'progress'] as const}
              labels={{ strict: '自动审批', progress: '自动审批 · 推进' }}
              onChange={(value) =>
                onDraft((next) => {
                  next.modes.subagent = value;
                })
              }
            />
          </Field>
        </div>
        <table style={{ borderCollapse: 'collapse', fontSize: 12.5 }}>
          <tbody>
            <tr>
              <td
                style={{
                  padding: '3px 12px 3px 0',
                  color: 'var(--dsw-alias-label-secondary)',
                }}
              >
                执行模式
              </td>
              <td>
                {state.executionMode === 'trusted'
                  ? 'trusted（无沙箱兜底）'
                  : 'guarded（workspace-write）'}
              </td>
            </tr>
            <tr>
              <td
                style={{
                  padding: '3px 12px 3px 0',
                  color: 'var(--dsw-alias-label-secondary)',
                }}
              >
                生效配置修订
              </td>
              <td>
                <code>{state.effectiveRevision}</code>
              </td>
            </tr>
            <tr>
              <td
                style={{
                  padding: '3px 12px 3px 0',
                  color: 'var(--dsw-alias-label-secondary)',
                }}
              >
                配置快照
              </td>
              <td>
                <code>{state.configSnapshotId}</code>
              </td>
            </tr>
            <tr>
              <td
                style={{
                  padding: '3px 12px 3px 0',
                  color: 'var(--dsw-alias-label-secondary)',
                }}
              >
                策略版本
              </td>
              <td>{state.policyVersion}</td>
            </tr>
            <tr>
              <td
                style={{
                  padding: '3px 12px 3px 0',
                  color: 'var(--dsw-alias-label-secondary)',
                }}
              >
                Reviewer
              </td>
              <td>{state.reviewerType}</td>
            </tr>
            <tr>
              <td
                style={{
                  padding: '3px 12px 3px 0',
                  color: 'var(--dsw-alias-label-secondary)',
                }}
              >
                审计
              </td>
              <td>
                {state.audit.health.state}
                {state.audit.health.lastError === null
                  ? ''
                  : ` — ${state.audit.health.lastError}`}
              </td>
            </tr>
            <tr>
              <td
                style={{
                  padding: '3px 12px 3px 0',
                  color: 'var(--dsw-alias-label-secondary)',
                }}
              >
                记录数 / 模型调用
              </td>
              <td>
                {state.audit.stats?.calls ?? 0} /{' '}
                {state.audit.stats?.modelCalls ?? 0}
              </td>
            </tr>
            <tr>
              <td
                style={{
                  padding: '3px 12px 3px 0',
                  color: 'var(--dsw-alias-label-secondary)',
                }}
              >
                数据库
              </td>
              <td>
                <code>{state.audit.path ?? '不可用'}</code>
              </td>
            </tr>
          </tbody>
        </table>
        {state.invalidConfigError === null ? null : (
          <Notice
            kind="error"
            text={`配置文件无效，当前使用上一份有效配置：${state.invalidConfigError}`}
          />
        )}
        {state.autoPresetError === null ? null : (
          <Notice
            kind="error"
            text={`auto 预设注册失败（可能已存在其他 auto review 提供者）：${state.autoPresetError}`}
          />
        )}
        {state.sessionRecordErrors.length === 0 ? null : (
          <Notice
            kind="info"
            text={`会话裁决记录写入异常（不影响当前权限结论）：\n${state.sessionRecordErrors.map(([id, message]) => `${id}: ${message}`).join('\n')}`}
          />
        )}
      </Section>
      <Section
        title="配置生效记录"
        description="内容快照按内容去重；每次成功应用新增一条生效记录。"
      >
        {state.configHistory.length === 0 ? (
          <p
            style={{
              margin: 0,
              color: 'var(--dsw-alias-label-tertiary)',
              fontSize: 12.5,
            }}
          >
            暂无记录。
          </p>
        ) : (
          <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr
                style={{
                  textAlign: 'left',
                  color: 'var(--dsw-alias-label-secondary)',
                }}
              >
                <th style={{ padding: 4 }}>时间</th>
                <th style={{ padding: 4 }}>修订</th>
                <th style={{ padding: 4 }}>入口</th>
                <th style={{ padding: 4 }}>快照</th>
              </tr>
            </thead>
            <tbody>
              {state.configHistory.slice(0, 5).map((activation) => (
                <tr
                  key={activation.id}
                  style={{
                    borderTop: '0.5px solid var(--dsw-alias-border-l2)',
                  }}
                >
                  <td style={{ padding: 4 }}>
                    {formatTime(activation.activatedAt)}
                  </td>
                  <td style={{ padding: 4 }}>
                    <code>{activation.revision}</code>
                  </td>
                  <td style={{ padding: 4 }}>
                    {activation.entry} / {activation.scope}
                  </td>
                  <td style={{ padding: 4 }}>
                    <code>{activation.snapshotId}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <Section
        title="覆盖范围"
        description="能拦截入口，不等于能观察工具实现内部的每个效果。"
      >
        <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
          <div>
            <strong>已接入</strong>
          </div>
          <ul style={{ margin: '4px 0 10px', paddingLeft: 20 }}>
            {state.coverage.gated.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div>
            <strong>不逐项覆盖</strong>
          </div>
          <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
            {state.coverage.notGated.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </Section>
    </>
  );
}

function RulesPanel(props: {
  readonly draft: Draft;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
}): ReactNode {
  const { draft, onDraft } = props;
  const [testInput, setTestInput] = useState(
    'gh pr view 42\ngpt-relay send --to-prod\nrm -rf /tmp/build',
  );
  const [testResults, setTestResults] = useState<readonly RuleTestResult[]>([]);
  const [testError, setTestError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const updateRule = (
    index: number,
    mutator: (rule: DraftRule) => void,
  ): void => {
    onDraft((next) => {
      const rule = next.rules[index];
      if (rule === undefined) return;
      mutator(rule);
    });
  };

  const runTest = async (): Promise<void> => {
    setBusy(true);
    setTestError(null);
    try {
      const response = await postJson<{
        readonly ok: boolean;
        readonly results: readonly RuleTestResult[];
      }>('/test', {
        inputs: testInput
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
        rules: draft.rules,
      });
      setTestResults(response.results);
    } catch (error) {
      setTestError(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section
        title="规则表"
        description="优先级固定为 deny > force-ask > force-review > allow > review(default)；同一层内按此列表顺序。"
      >
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}
          >
            <thead>
              <tr
                style={{
                  textAlign: 'left',
                  color: 'var(--dsw-alias-label-secondary)',
                }}
              >
                <th style={{ padding: 6 }}>启用</th>
                <th style={{ padding: 6 }}>ID</th>
                <th style={{ padding: 6 }}>节点</th>
                <th style={{ padding: 6 }}>匹配</th>
                <th style={{ padding: 6 }}>Tool / 参数选择器</th>
                <th style={{ padding: 6 }}>行为</th>
                <th style={{ padding: 6 }}>匹配范围</th>
                <th style={{ padding: 6 }}>备注 / hint</th>
                <th style={{ padding: 6 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {draft.rules.map((rule, index) => (
                <tr
                  key={`${rule.id}-${String(index)}`}
                  style={{
                    borderTop: '0.5px solid var(--dsw-alias-border-l2)',
                  }}
                >
                  <td style={{ padding: 6 }}>
                    <input
                      type="checkbox"
                      checked={rule.enabled !== false}
                      onChange={(event) =>
                        updateRule(index, (next) => {
                          next.enabled = event.target.checked;
                        })
                      }
                    />
                  </td>
                  <td style={{ padding: 6, minWidth: 120 }}>
                    <TextInput
                      value={rule.id}
                      onChange={(value) =>
                        updateRule(index, (next) => {
                          next.id = value;
                        })
                      }
                      monospace
                    />
                  </td>
                  <td style={{ padding: 6 }}>
                    <Select
                      value={rule.match.node}
                      options={NODES}
                      onChange={(value) =>
                        updateRule(index, (next) => {
                          next.match.node = value;
                        })
                      }
                    />
                  </td>
                  <td style={{ padding: 6, minWidth: 220 }}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <div style={{ width: 86 }}>
                        <Select
                          value={rule.match.kind}
                          options={KINDS}
                          onChange={(value) =>
                            updateRule(index, (next) => {
                              next.match.kind = value;
                            })
                          }
                        />
                      </div>
                      <TextInput
                        value={rule.match.pattern}
                        onChange={(value) =>
                          updateRule(index, (next) => {
                            next.match.pattern = value;
                          })
                        }
                        monospace
                      />
                    </div>
                  </td>
                  <td style={{ padding: 6, minWidth: 150 }}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <TextInput
                        value={rule.match.tool ?? ''}
                        placeholder="tool"
                        onChange={(value) =>
                          updateRule(index, (next) => {
                            if (value.length === 0) delete next.match.tool;
                            else next.match.tool = value;
                          })
                        }
                        monospace
                      />
                      <TextInput
                        value={rule.match.selector ?? ''}
                        placeholder="selector"
                        onChange={(value) =>
                          updateRule(index, (next) => {
                            if (value.length === 0) delete next.match.selector;
                            else next.match.selector = value;
                          })
                        }
                        monospace
                      />
                    </div>
                  </td>
                  <td style={{ padding: 6, minWidth: 110 }}>
                    <Select
                      value={rule.verdict}
                      options={VERDICTS}
                      labels={{
                        allow: '免审放行',
                        deny: '禁止',
                        'force-ask': '必须人工',
                        'force-review': '必须审查',
                      }}
                      onChange={(value) =>
                        updateRule(index, (next) => {
                          next.verdict = value;
                        })
                      }
                    />
                  </td>
                  <td style={{ padding: 6, minWidth: 150 }}>
                    <TextInput
                      value={(rule.match.agents ?? []).join(', ')}
                      placeholder="main, subagent"
                      onChange={(value) =>
                        updateRule(index, (next) => {
                          const agents = value
                            .split(',')
                            .map((item) => item.trim())
                            .filter((item) => item.length > 0);
                          if (agents.length === 0) delete next.match.agents;
                          else next.match.agents = agents;
                        })
                      }
                    />
                  </td>
                  <td style={{ padding: 6, whiteSpace: 'nowrap' }}>
                    <Button
                      onClick={() =>
                        onDraft((next) => {
                          next.rules.splice(index, 1);
                        })
                      }
                      tone="danger"
                    >
                      删除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            onClick={() =>
              onDraft((next) => {
                next.rules.push({
                  id: `rule-${String(next.rules.length + 1)}`,
                  match: { node: 'command', kind: 'regex', pattern: '^' },
                  verdict: 'allow',
                  comment: '',
                });
              })
            }
          >
            + 添加规则
          </Button>
        </div>
        <p
          style={{
            margin: 0,
            color: 'var(--dsw-alias-label-tertiary)',
            fontSize: 11.5,
          }}
        >
          regex 使用 RE2 并要求以 ^ 锚定；路径目标使用
          glob。命令规则只决定是否进入审查，不覆盖已形成的审查拒绝，也不是沙箱升权。
        </p>
      </Section>

      <Section
        title="规则测试"
        description="只走规则层与 AST 解析；不调用 reviewer、不写审计、不执行命令。与 /arbiter test 使用同一实现。"
      >
        <textarea
          value={testInput}
          onChange={(event) => setTestInput(event.target.value)}
          rows={5}
          style={{
            ...inputStyle,
            height: 'auto',
            padding: 8,
            fontFamily: 'var(--dsw-font-mono, monospace)',
          }}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button
            onClick={() => {
              void runTest();
            }}
            disabled={busy}
            tone="primary"
          >
            {busy ? '测试中…' : '运行测试'}
          </Button>
          <span
            style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 11.5 }}
          >
            一行一条；支持 `bash: …`、`read: …` 或 JSON。
          </span>
        </div>
        {testError === null ? null : <Notice kind="error" text={testError} />}
        {testResults.length === 0 ? null : (
          <table
            style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}
          >
            <thead>
              <tr
                style={{
                  textAlign: 'left',
                  color: 'var(--dsw-alias-label-secondary)',
                }}
              >
                <th style={{ padding: 6 }}>规则路径</th>
                <th style={{ padding: 6 }}>输入</th>
                <th style={{ padding: 6 }}>命中规则</th>
                <th style={{ padding: 6 }}>被遮蔽 / 事实</th>
              </tr>
            </thead>
            <tbody>
              {testResults.map((result, index) => (
                <tr
                  key={`${result.input}-${String(index)}`}
                  onClick={() => setExpanded(expanded === index ? null : index)}
                  style={{
                    borderTop: '0.5px solid var(--dsw-alias-border-l2)',
                    cursor: 'pointer',
                    verticalAlign: 'top',
                  }}
                >
                  <td
                    style={{
                      padding: 6,
                      fontFamily: 'var(--dsw-font-mono, monospace)',
                    }}
                  >
                    {result.path}
                  </td>
                  <td
                    style={{
                      padding: 6,
                      fontFamily: 'var(--dsw-font-mono, monospace)',
                    }}
                  >
                    {result.input}
                  </td>
                  <td style={{ padding: 6 }}>
                    {result.rule?.id ?? '(未命中)'}
                  </td>
                  <td style={{ padding: 6 }}>
                    {result.shadowed.length > 0
                      ? result.shadowed.join(', ')
                      : '—'}
                    <div style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
                      {result.parse.completeness} ·{' '}
                      {result.parse.nodes.join(', ') || '—'}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {expanded === null ? null : <JsonBlock value={testResults[expanded]} />}
      </Section>
    </>
  );
}

function ReviewerPanel(props: {
  readonly draft: Draft;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
}): ReactNode {
  const { draft, onDraft } = props;
  const [credential, setCredential] = useState<{
    readonly configured: boolean;
    readonly source: string | null;
    readonly supported: boolean;
    readonly message?: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getJson<{
      readonly configured: boolean;
      readonly source: string | null;
      readonly supported: boolean;
      readonly message?: string;
    }>('/credentials')
      .then((value) => {
        if (!cancelled) setCredential(value);
      })
      .catch(() => {
        if (!cancelled) setCredential(null);
      });
    return () => {
      cancelled = true;
    };
  }, [draft.reviewer.decision.apiKeyRef]);

  return (
    <>
      <Section
        title="Reviewer 类型"
        description="二选一，不做自动回退。选择 chat 时使用 DSH 的 LLM 服务；decision 直接调用兼容 Clef / Jev 的 REST 后端。"
      >
        <div style={{ display: 'flex', gap: 16 }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 13,
            }}
          >
            <input
              type="radio"
              checked={draft.reviewer.type === 'chat'}
              onChange={() =>
                onDraft((next) => {
                  next.reviewer.type = 'chat';
                })
              }
            />
            chat（点值 + 四探针）
          </label>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 13,
            }}
          >
            <input
              type="radio"
              checked={draft.reviewer.type === 'decision'}
              onChange={() =>
                onDraft((next) => {
                  next.reviewer.type = 'decision';
                })
              }
            />
            decision（分布 + 四探针）
          </label>
        </div>
        {draft.reviewer.type === 'chat' ? (
          <div
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}
          >
            <Field
              label="provider"
              hint='填 "session" 复用当前会话模型（官方 session 变体）。'
            >
              <TextInput
                value={draft.reviewer.chat.provider}
                onChange={(value) =>
                  onDraft((next) => {
                    next.reviewer.chat.provider = value;
                  })
                }
              />
            </Field>
            <Field label="model" hint="provider 为 session 时 model 可留空。">
              <TextInput
                value={draft.reviewer.chat.model}
                onChange={(value) =>
                  onDraft((next) => {
                    next.reviewer.chat.model = value;
                  })
                }
              />
            </Field>
            <Field label="temperature">
              <NumberInput
                value={draft.reviewer.chat.temperature}
                min={0}
                max={2}
                step={0.1}
                onChange={(value) =>
                  onDraft((next) => {
                    next.reviewer.chat.temperature = value;
                  })
                }
              />
            </Field>
            <Field label="maxTokens">
              <NumberInput
                value={draft.reviewer.chat.maxTokens}
                min={16}
                max={4000}
                onChange={(value) =>
                  onDraft((next) => {
                    next.reviewer.chat.maxTokens = value;
                  })
                }
              />
            </Field>
            <Field label="超时 (ms)">
              <NumberInput
                value={draft.reviewer.chat.timeoutMs}
                min={500}
                max={120000}
                onChange={(value) =>
                  onDraft((next) => {
                    next.reviewer.chat.timeoutMs = value;
                  })
                }
              />
            </Field>
            <Field
              label="修复重试次数"
              hint="只对 JSON / schema / 矛盾错误重试，provider 错误不重试。"
            >
              <NumberInput
                value={draft.reviewer.chat.maxRepairRetries}
                min={0}
                max={3}
                onChange={(value) =>
                  onDraft((next) => {
                    next.reviewer.chat.maxRepairRetries = value;
                  })
                }
              />
            </Field>
          </div>
        ) : (
          <div
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}
          >
            <Field label="URL">
              <TextInput
                value={draft.reviewer.decision.url}
                onChange={(value) =>
                  onDraft((next) => {
                    next.reviewer.decision.url = value;
                  })
                }
                monospace
              />
            </Field>
            <Field label="model">
              <TextInput
                value={draft.reviewer.decision.model}
                onChange={(value) =>
                  onDraft((next) => {
                    next.reviewer.decision.model = value;
                  })
                }
                monospace
              />
            </Field>
            <Field
              label="凭据引用 (apiKeyRef)"
              hint="这里只存引用名，不存密钥值。"
            >
              <TextInput
                value={draft.reviewer.decision.apiKeyRef}
                onChange={(value) =>
                  onDraft((next) => {
                    next.reviewer.decision.apiKeyRef = value;
                  })
                }
                monospace
              />
            </Field>
            <Field label="超时 (ms)">
              <NumberInput
                value={draft.reviewer.decision.timeoutMs}
                min={500}
                max={120000}
                onChange={(value) =>
                  onDraft((next) => {
                    next.reviewer.decision.timeoutMs = value;
                  })
                }
              />
            </Field>
            <Field label="成本标记">
              <Select
                value={draft.reviewer.decision.costTier}
                options={['free', 'paid'] as const}
                onChange={(value) =>
                  onDraft((next) => {
                    next.reviewer.decision.costTier = value;
                  })
                }
              />
            </Field>
            <Field label="凭据状态">
              <span style={{ fontSize: 12.5, lineHeight: '30px' }}>
                {credential === null
                  ? '读取中…'
                  : credential.supported === false
                    ? '当前 composition 没有 credentials 服务'
                    : credential.configured
                      ? `已设置${credential.source === null ? '' : `（来源 ${credential.source}）`}`
                      : '未设置'}
              </span>
            </Field>
          </div>
        )}
        <p
          style={{
            margin: 0,
            color: 'var(--dsw-alias-label-tertiary)',
            fontSize: 11.5,
          }}
        >
          后端不可用、超时或输出非法时进入
          error-escalate，不自动放行、不切换后端。decision 的 11 级 criteria
          由插件内置。
        </p>
      </Section>
    </>
  );
}

function AdvancedPanel(props: {
  readonly draft: Draft;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
}): ReactNode {
  const { draft, onDraft } = props;
  const thresholdFields = [
    ['tauAuth', '授权概率门 τ_auth', 0, 1, 0.05],
    ['tauRisk', '风险概率门 τ_risk', 0, 1, 0.05],
    ['tauCritical', 'critical 概率门', 0, 1, 0.05],
    ['tauLow', '低风险概率门', 0, 1, 0.05],
    ['chatLowRiskMax', 'chat 低风险上限', 0, 10, 1],
    ['chatMediumRiskMax', 'chat 中风险上限', 0, 10, 1],
    ['mediumRiskCeiling', 'decision 风险上限', 0, 10, 1],
    ['explicitFromRisk', '需要明确授权的最低风险', 0, 10, 1],
  ] as const;

  return (
    <>
      <Section
        title="审查策略"
        description="normal 与 strict 共用同一份常规策略；progress 使用右侧扩展条件。阈值未经校准，属于可调整初值。"
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: 10,
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 12.5 }}>参数</div>
          <div style={{ fontWeight: 600, fontSize: 12.5 }}>
            常规（normal / strict）
          </div>
          <div style={{ fontWeight: 600, fontSize: 12.5 }}>progress</div>
          {thresholdFields.map(([key, label, min, max, step]) => (
            <div key={key} style={{ display: 'contents' }}>
              <div style={{ fontSize: 12.5, lineHeight: '30px' }}>{label}</div>
              <NumberInput
                value={draft.policy.normal[key]}
                min={min}
                max={max}
                step={step}
                onChange={(value) =>
                  onDraft((next) => {
                    next.policy.normal[key] = value;
                  })
                }
              />
              <NumberInput
                value={draft.policy.progress[key]}
                min={min}
                max={max}
                step={step}
                onChange={(value) =>
                  onDraft((next) => {
                    next.policy.progress[key] = value;
                  })
                }
              />
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 16 }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12.5,
            }}
          >
            <input
              type="checkbox"
              checked={draft.policy.progress.allowBulkEgress}
              onChange={(event) =>
                onDraft((next) => {
                  next.policy.progress.allowBulkEgress = event.target.checked;
                })
              }
            />
            progress 允许明确授权的普通批量外发（R6）
          </label>
          <Field label="探针模式">
            <Select
              value={draft.policy.probeMode}
              options={['assist', 'override'] as const}
              labels={{
                assist: 'assist（事实只作输入）',
                override: 'override（事实可置真）',
              }}
              onChange={(value) =>
                onDraft((next) => {
                  next.policy.probeMode = value;
                })
              }
            />
          </Field>
        </div>
      </Section>

      <Section title="上下文与输入预算">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: 12,
          }}
        >
          <Field label="最大输入 tokens">
            <NumberInput
              value={draft.context.maxInputTokens}
              min={1000}
              max={200000}
              onChange={(value) =>
                onDraft((next) => {
                  next.context.maxInputTokens = value;
                })
              }
            />
          </Field>
          <Field label="授权证据条数">
            <NumberInput
              value={draft.context.evidenceMaxItems}
              min={1}
              max={200}
              onChange={(value) =>
                onDraft((next) => {
                  next.context.evidenceMaxItems = value;
                })
              }
            />
          </Field>
          <Field label="父会话人类原话条数">
            <NumberInput
              value={draft.context.parentHumanItems}
              min={0}
              max={100}
              onChange={(value) =>
                onDraft((next) => {
                  next.context.parentHumanItems = value;
                })
              }
            />
          </Field>
          <Field label="父证据保底">
            <NumberInput
              value={draft.context.parentEvidenceFloor}
              min={0}
              max={100}
              onChange={(value) =>
                onDraft((next) => {
                  next.context.parentEvidenceFloor = value;
                })
              }
            />
          </Field>
          <Field label="历史与裁决上限">
            <NumberInput
              value={draft.context.historyMaxItems}
              min={1}
              max={400}
              onChange={(value) =>
                onDraft((next) => {
                  next.context.historyMaxItems = value;
                })
              }
            />
          </Field>
          <Field label="checkpoint 上限">
            <NumberInput
              value={draft.context.checkpointMaxItems}
              min={0}
              max={20}
              onChange={(value) =>
                onDraft((next) => {
                  next.context.checkpointMaxItems = value;
                })
              }
            />
          </Field>
          <Field label="历史工具参数截断字符">
            <NumberInput
              value={draft.context.toolCallArgumentMaxChars}
              min={20}
              max={10000}
              onChange={(value) =>
                onDraft((next) => {
                  next.context.toolCallArgumentMaxChars = value;
                })
              }
            />
          </Field>
          <Field label="项目规则文件">
            <TextInput
              value={draft.context.projectRules.files.join(', ')}
              onChange={(value) =>
                onDraft((next) => {
                  next.context.projectRules.files = value
                    .split(',')
                    .map((item) => item.trim())
                    .filter((item) => item.length > 0);
                })
              }
              monospace
            />
          </Field>
          <Field label="读取项目规则">
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                height: 30,
                fontSize: 12.5,
              }}
            >
              <input
                type="checkbox"
                checked={draft.context.projectRules.enabled}
                onChange={(event) =>
                  onDraft((next) => {
                    next.context.projectRules.enabled = event.target.checked;
                  })
                }
              />
              启用
            </label>
          </Field>
        </div>
        <Field label="CUSTOM_RULES（全局审查指引，最多 2000 字符）">
          <textarea
            value={draft.context.customRules}
            rows={5}
            onChange={(event) =>
              onDraft((next) => {
                next.context.customRules = event.target.value;
              })
            }
            style={{ ...inputStyle, height: 'auto', padding: 8 }}
          />
        </Field>
      </Section>

      <Section title="审计与熔断">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: 12,
          }}
        >
          <Field label="保留天数">
            <NumberInput
              value={draft.audit.retentionDays}
              min={1}
              max={3650}
              onChange={(value) =>
                onDraft((next) => {
                  next.audit.retentionDays = value;
                })
              }
            />
          </Field>
          <Field label="容量目标 (bytes)">
            <NumberInput
              value={draft.audit.retentionBytes}
              min={1024 * 1024}
              max={1024 * 1024 * 1024 * 1024}
              onChange={(value) =>
                onDraft((next) => {
                  next.audit.retentionBytes = value;
                })
              }
            />
          </Field>
          <Field label="审计队列容量">
            <NumberInput
              value={draft.audit.maxQueue}
              min={1}
              max={100000}
              onChange={(value) =>
                onDraft((next) => {
                  next.audit.maxQueue = value;
                })
              }
            />
          </Field>
          <Field label="熔断模式">
            <Select
              value={draft.breaker.mode}
              options={['off', 'preset', 'custom'] as const}
              onChange={(value) =>
                onDraft((next) => {
                  next.breaker.mode = value;
                })
              }
            />
          </Field>
          <Field label="预设">
            <Select
              value={draft.breaker.preset}
              options={['strict', 'balanced', 'lenient'] as const}
              onChange={(value) =>
                onDraft((next) => {
                  next.breaker.preset = value;
                })
              }
            />
          </Field>
          <Field label="审查预算（null = 不限）">
            <TextInput
              value={
                draft.reviewBudget === null ? '' : String(draft.reviewBudget)
              }
              placeholder="null"
              onChange={(value) =>
                onDraft((next) => {
                  next.reviewBudget =
                    value.trim().length === 0 ? null : Number(value);
                })
              }
            />
          </Field>
        </div>
        {draft.breaker.mode === 'custom' ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1fr',
              gap: 12,
            }}
          >
            <Field label="连续拒绝">
              <NumberInput
                value={draft.breaker.consecutiveDenials}
                min={0}
                max={100}
                onChange={(value) =>
                  onDraft((next) => {
                    next.breaker.consecutiveDenials = value;
                  })
                }
              />
            </Field>
            <Field label="窗口内拒绝">
              <NumberInput
                value={draft.breaker.windowDenials}
                min={0}
                max={100}
                onChange={(value) =>
                  onDraft((next) => {
                    next.breaker.windowDenials = value;
                  })
                }
              />
            </Field>
            <Field label="窗口大小">
              <NumberInput
                value={draft.breaker.windowSize}
                min={1}
                max={100}
                onChange={(value) =>
                  onDraft((next) => {
                    next.breaker.windowSize = value;
                  })
                }
              />
            </Field>
          </div>
        ) : null}
        <p
          style={{
            margin: 0,
            color: 'var(--dsw-alias-label-tertiary)',
            fontSize: 11.5,
          }}
        >
          审计写入失败不改变权限结果。清理日志只删除 SQLite 审计，不删除 DSH
          会话裁决记录。
        </p>
      </Section>
    </>
  );
}

function LogsPanel(): ReactNode {
  const [rows, setRows] = useState<readonly LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [result, setResult] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detail, setDetail] = useState<LogDetail | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (result.length > 0) params.set('result', result);
      if (query.length > 0) params.set('q', query);
      const response = await getJson<{
        readonly ok: boolean;
        readonly rows: readonly LogRow[];
        readonly total: number;
        readonly health?: AuditHealthView;
        readonly code?: string;
      }>(`/logs?${params.toString()}`);
      setRows(response.rows);
      setTotal(response.total);
      if (response.code === 'audit-unavailable')
        setError('审计存储不可用；当前审批仍继续，历史可能缺失。');
    } catch (errorValue) {
      setError(errorText(errorValue));
    } finally {
      setBusy(false);
    }
  }, [query, result]);

  useEffect(() => {
    void load();
  }, [load]);

  const clear = async (): Promise<void> => {
    if (
      !window.confirm(
        '清理 SQLite 审计记录？会话裁决记录和当前内存状态不受影响。',
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const response = await postJson<{
        readonly ok: boolean;
        readonly deleted: number;
      }>('/clear', {});
      setNotice(`已清理 ${String(response.deleted)} 条审计记录。`);
      await load();
    } catch (errorValue) {
      setError(errorText(errorValue));
    } finally {
      setBusy(false);
    }
  };

  const open = async (callId: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await getJson<{
        readonly ok: boolean;
        readonly record: LogDetail;
      }>(`/log?callId=${encodeURIComponent(callId)}`);
      setDetail(response.record);
    } catch (errorValue) {
      setError(errorText(errorValue));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section
        title="调用记录"
        description="权限决定与执行结果分开显示。规则短路不会显示成“模型已检查授权”。"
      >
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'flex-end',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ width: 180 }}>
            <Field label="结果">
              <Select
                value={result}
                options={
                  [
                    '',
                    'allow',
                    'deny',
                    'review-allow',
                    'review-deny',
                    'review-escalate',
                    'human-allow',
                    'human-deny',
                    'human-abort',
                    'fallback-deny',
                  ] as const
                }
                labels={{ '': '全部' }}
                onChange={setResult}
              />
            </Field>
          </div>
          <div style={{ width: 260 }}>
            <Field label="搜索">
              <TextInput
                value={query}
                onChange={setQuery}
                placeholder="命令、原因或工具名"
              />
            </Field>
          </div>
          <Button
            onClick={() => {
              void load();
            }}
            disabled={busy}
            tone="primary"
          >
            {busy ? '读取中…' : '刷新'}
          </Button>
          <span
            style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}
          >
            共 {total} 条
          </span>
        </div>
        {error === null ? null : <Notice kind="error" text={error} />}
        <table
          style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}
        >
          <thead>
            <tr
              style={{
                textAlign: 'left',
                color: 'var(--dsw-alias-label-secondary)',
              }}
            >
              <th style={{ padding: 6 }}>时间</th>
              <th style={{ padding: 6 }}>工具</th>
              <th style={{ padding: 6 }}>命令 / 参数</th>
              <th style={{ padding: 6 }}>结果</th>
              <th style={{ padding: 6 }}>规则</th>
              <th style={{ padding: 6 }}>审批模式</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.callId}
                onClick={() => {
                  void open(row.callId);
                }}
                style={{
                  borderTop: '0.5px solid var(--dsw-alias-border-l2)',
                  cursor: 'pointer',
                  verticalAlign: 'top',
                }}
              >
                <td style={{ padding: 6, whiteSpace: 'nowrap' }}>
                  {formatTime(row.ts)}
                </td>
                <td
                  style={{
                    padding: 6,
                    fontFamily: 'var(--dsw-font-mono, monospace)',
                  }}
                >
                  {row.tool}
                </td>
                <td
                  style={{
                    padding: 6,
                    fontFamily: 'var(--dsw-font-mono, monospace)',
                    maxWidth: 420,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {row.command}
                </td>
                <td style={{ padding: 6 }}>{row.result}</td>
                <td style={{ padding: 6 }}>{row.ruleId ?? '—'}</td>
                <td style={{ padding: 6 }}>{row.approvalMode}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  style={{
                    padding: 12,
                    color: 'var(--dsw-alias-label-tertiary)',
                  }}
                >
                  没有记录。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Section>
      {detail === null ? null : (
        <Section
          title={`调用详情 · ${detail.callId}`}
          description={`${formatTime(detail.ts)} · ${detail.sessionKind} · ${detail.executionMode}`}
        >
          <table style={{ borderCollapse: 'collapse', fontSize: 12.5 }}>
            <tbody>
              <tr>
                <td
                  style={{
                    padding: '3px 12px 3px 0',
                    color: 'var(--dsw-alias-label-secondary)',
                  }}
                >
                  权限结果
                </td>
                <td>{detail.result}</td>
              </tr>
              <tr>
                <td
                  style={{
                    padding: '3px 12px 3px 0',
                    color: 'var(--dsw-alias-label-secondary)',
                  }}
                >
                  执行状态
                </td>
                <td>{detail.executionStatus}</td>
              </tr>
              <tr>
                <td
                  style={{
                    padding: '3px 12px 3px 0',
                    color: 'var(--dsw-alias-label-secondary)',
                  }}
                >
                  原因
                </td>
                <td>{detail.reason}</td>
              </tr>
              <tr>
                <td
                  style={{
                    padding: '3px 12px 3px 0',
                    color: 'var(--dsw-alias-label-secondary)',
                  }}
                >
                  配置修订
                </td>
                <td>
                  <code>{detail.configRevision}</code>
                </td>
              </tr>
              <tr>
                <td
                  style={{
                    padding: '3px 12px 3px 0',
                    color: 'var(--dsw-alias-label-secondary)',
                  }}
                >
                  会话记录
                </td>
                <td>{detail.sessionRecordState}</td>
              </tr>
              <tr>
                <td
                  style={{
                    padding: '3px 12px 3px 0',
                    color: 'var(--dsw-alias-label-secondary)',
                  }}
                >
                  指纹
                </td>
                <td>
                  <code>{detail.fingerprint}</code>
                </td>
              </tr>
            </tbody>
          </table>
          <div>
            <strong style={{ fontSize: 13 }}>判定链</strong>
            <ol style={{ margin: '6px 0 0', paddingLeft: 20, fontSize: 12.5 }}>
              {detail.stages.map((stage) => (
                <li key={`${String(stage.seq)}-${stage.stage}`}>
                  {stage.stage} → {stage.result}
                  {stage.ruleId === null ? '' : ` (${stage.ruleId})`}
                  {stage.decisionRules.length === 0
                    ? ''
                    : ` [${stage.decisionRules.join(', ')}]`}
                  {stage.reason === null ? '' : ` — ${stage.reason}`}
                </li>
              ))}
            </ol>
          </div>
          <details open>
            <summary style={{ cursor: 'pointer', fontSize: 13 }}>
              送审材料（ReviewSnapshot）
            </summary>
            <JsonBlock value={detail.snapshot} />
          </details>
          <details>
            <summary style={{ cursor: 'pointer', fontSize: 13 }}>
              信号与配置
            </summary>
            <JsonBlock
              value={{
                signals: detail.signals,
                policyStrategy: detail.policyStrategy,
                decisionRules: detail.decisionRules,
                config: detail.config,
              }}
            />
          </details>
          <details>
            <summary style={{ cursor: 'pointer', fontSize: 13 }}>
              模型调用（{detail.modelCalls.length}）
            </summary>
            <JsonBlock value={detail.modelCalls} />
          </details>
        </Section>
      )}
    </>
  );
}

function SuggestionsPanel(props: {
  readonly onApplied: () => void;
}): ReactNode {
  const [candidates, setCandidates] = useState<readonly CandidateView[]>([]);
  const [replay, setReplay] = useState<ReplayView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Record<string, string>>({});

  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const response = await getJson<{
        readonly ok: boolean;
        readonly candidates: readonly CandidateView[];
      }>('/suggestions');
      setCandidates(response.candidates);
    } catch (errorValue) {
      setError(errorText(errorValue));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const analyze = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await postJson<{
        readonly ok: boolean;
        readonly proposals: readonly unknown[];
        readonly created: number;
      }>('/analyze', { windowDays: 30, minOccurrences: 3 });
      setNotice(
        `本轮生成 ${String(response.proposals.length)} 个候选，新增 ${String(response.created)} 个待审核项。`,
      );
      await load();
    } catch (errorValue) {
      setError(errorText(errorValue));
    } finally {
      setBusy(false);
    }
  };

  const act = async (
    candidate: CandidateView,
    action: 'accept' | 'reject',
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const edited = editing[candidate.candidateId];
      const rule =
        edited === undefined ? candidate.rule : (JSON.parse(edited) as unknown);
      await postJson('/suggestions/act', {
        candidateId: candidate.candidateId,
        action,
        rule,
      });
      setNotice(
        action === 'accept'
          ? '候选已通过普通配置校验并加入正式规则。'
          : '候选已拒绝。',
      );
      await load();
      props.onApplied();
    } catch (errorValue) {
      setError(errorText(errorValue));
    } finally {
      setBusy(false);
    }
  };

  const loadReplay = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setReplay(
        await getJson<ReplayView & { readonly ok: boolean }>('/replay'),
      );
    } catch (errorValue) {
      setError(errorText(errorValue));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section
        title="离线规则建议"
        description="候选只从本地历史生成，确认前不参与运行时匹配。确认后与手工规则完全相同，遵循普通配置校验。"
      >
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button
            onClick={() => {
              void analyze();
            }}
            disabled={busy}
            tone="primary"
          >
            分析最近 30 天
          </Button>
          <Button
            onClick={() => {
              void loadReplay();
            }}
            disabled={busy}
          >
            策略回放（normal vs progress）
          </Button>
          <Button
            onClick={() => {
              void load();
            }}
            disabled={busy}
          >
            刷新候选
          </Button>
        </div>
        {error === null ? null : <Notice kind="error" text={error} />}
        {notice === null ? null : <Notice kind="ok" text={notice} />}
        {replay === null ? null : (
          <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
            <div>
              可比记录：{replay.comparable} / {replay.considered}；normal 放行{' '}
              {replay.normalAllow}，progress 放行 {replay.progressAllow}
              ；promoted {replay.promoted}；变化 {replay.changed}。
            </div>
            <div style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
              回放只使用已保存信号，不再次调用模型；缺字段的记录不伪造结论。
            </div>
            {replay.items.length === 0 ? null : (
              <JsonBlock value={replay.items} />
            )}
          </div>
        )}
        {candidates.length === 0 ? (
          <p
            style={{
              margin: 0,
              color: 'var(--dsw-alias-label-tertiary)',
              fontSize: 12.5,
            }}
          >
            暂无候选。需要足够多的完全解析、全部放行且无硬类别信号的调用。
          </p>
        ) : (
          candidates.map((candidate) => {
            const ruleText = JSON.stringify(candidate.rule, null, 2);
            return (
              <div
                key={candidate.candidateId}
                style={{
                  border: '0.5px solid var(--dsw-alias-border-l3)',
                  borderRadius: 8,
                  padding: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <strong style={{ fontSize: 13 }}>
                    {candidate.candidateId}
                  </strong>
                  <span
                    style={{
                      fontSize: 12,
                      color: 'var(--dsw-alias-label-tertiary)',
                    }}
                  >
                    {candidate.status}
                  </span>
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: 10,
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--dsw-alias-label-secondary)',
                        marginBottom: 4,
                      }}
                    >
                      统计依据
                    </div>
                    <JsonBlock value={candidate.stats} />
                  </div>
                  <div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--dsw-alias-label-secondary)',
                        marginBottom: 4,
                      }}
                    >
                      代表案例
                    </div>
                    <JsonBlock value={candidate.evidence} />
                  </div>
                </div>
                <div>
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--dsw-alias-label-secondary)',
                      marginBottom: 4,
                    }}
                  >
                    拟加入的规则（可修改）
                  </div>
                  <textarea
                    value={editing[candidate.candidateId] ?? ruleText}
                    rows={10}
                    onChange={(event) =>
                      setEditing((current) => ({
                        ...current,
                        [candidate.candidateId]: event.target.value,
                      }))
                    }
                    style={{
                      ...inputStyle,
                      height: 'auto',
                      padding: 8,
                      fontFamily: 'var(--dsw-font-mono, monospace)',
                    }}
                  />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button
                    onClick={() => {
                      void act(candidate, 'accept');
                    }}
                    disabled={busy || candidate.status !== 'pending'}
                    tone="primary"
                  >
                    确认添加
                  </Button>
                  <Button
                    onClick={() => {
                      void act(candidate, 'reject');
                    }}
                    disabled={busy || candidate.status !== 'pending'}
                    tone="danger"
                  >
                    拒绝
                  </Button>
                  <span
                    style={{
                      fontSize: 11.5,
                      color: 'var(--dsw-alias-label-tertiary)',
                      lineHeight: '30px',
                    }}
                  >
                    统计只说明过去的可见结果，不能证明未来调用安全。
                  </span>
                </div>
              </div>
            );
          })
        )}
      </Section>
    </>
  );
}

function AboutPanel(props: { readonly state: StateResponse }): ReactNode {
  return (
    <>
      <Section
        title="试用步骤"
        description="使用隔离 profile；不要先改日常 profile。"
      >
        <pre
          style={{
            margin: 0,
            padding: 12,
            borderRadius: 6,
            background: 'var(--dsw-alias-bg-module-platform)',
            fontSize: 12,
            fontFamily: 'var(--dsw-font-mono, monospace)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {`# 1. 安装到隔离 profile
dsh plugin --profile arbiter add /Volumes/sandisk/code/dsh-arbiter

# 2. 启动该 profile
dsh --profile arbiter web

# 3. 打开侧栏 Plugins → dsh-arbiter → 配置页
# 4. 选择 reviewer，创建 allow / force-review 规则，运行 /arbiter status 或规则测试
# 5. 在日志页查看每次调用为什么被放行或拒绝`}
        </pre>
        <p
          style={{
            margin: 0,
            fontSize: 12.5,
            color: 'var(--dsw-alias-label-secondary)',
          }}
        >
          当前执行模式：{props.state.executionMode}
          。插件不修改宿主核心，不自动切换日常 profile，也不自动应答沙箱升权。
        </p>
      </Section>
      <Section title="已验证边界">
        <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
          <div>
            <strong>已接入</strong>
          </div>
          <ul style={{ margin: '4px 0 10px', paddingLeft: 20 }}>
            {props.state.coverage.gated.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div>
            <strong>不逐项覆盖</strong>
          </div>
          <ul style={{ margin: '4px 0 10px', paddingLeft: 20 }}>
            {props.state.coverage.notGated.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div>
            <strong>停用与卸载</strong>
          </div>
          <p style={{ margin: '4px 0 0' }}>
            插件停用后不再新增判定；已写入的规则、候选与审计保留。卸载不会自动清理
            SQLite，也不会把原有会话切回其他 preset；托管 auto 预设的迁移与官方
            auto review 相同，应先在隔离 profile 确认。
          </p>
        </div>
      </Section>
      <Section title="已知限制">
        <ul
          style={{
            margin: 0,
            paddingLeft: 20,
            fontSize: 12.5,
            lineHeight: 1.7,
          }}
        >
          <li>
            阈值、progress
            额外代批范围未经校准；日志只给出失败率下界，误放率需要人工复核。
          </li>
          <li>
            真实人工审批、Web 之外的 surface、外部后端子任务、MCP 动态列表与
            workflow 后台组合未在本轮验证。
          </li>
          <li>
            子任务无人工通道；需要人工的调用进入 fallback-deny，只结束当前调用。
          </li>
          <li>
            项目规则文件默认只作为审查指引，不被当作人类授权，也不覆盖插件策略。
          </li>
          <li>
            `prepend` 不能保证本插件排在其他审查者之前；插件内部保证规则先于自身
            reviewer。
          </li>
        </ul>
      </Section>
    </>
  );
}

export function ArbiterPage(_props: SlotProps): ReactNode {
  const [state, setState] = useState<StateResponse | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<TabId>('status');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState<{
    readonly errors: readonly ConfigError[];
    readonly warnings: readonly ConfigWarning[];
  }>({ errors: [], warnings: [] });
  const generation = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const ticket = generation.current + 1;
    generation.current = ticket;
    setBusy(true);
    setError(null);
    try {
      const value = await getJson<StateResponse>('/state');
      if (generation.current !== ticket) return;
      setState(value);
      setDraft(cloneDraft(value.config));
      setDirty(false);
      setValidation({ errors: value.loadErrors, warnings: value.warnings });
    } catch (errorValue) {
      if (generation.current === ticket) setError(errorText(errorValue));
    } finally {
      if (generation.current === ticket) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onDraft = useCallback((mutator: (draft: Draft) => void): void => {
    setDraft((current) => {
      if (current === null) return current;
      const next = cloneDraft(current);
      mutator(next);
      setDirty(true);
      return next;
    });
  }, []);

  const validate = useCallback(async (): Promise<void> => {
    if (draft === null) return;
    try {
      const response = await postJson<{
        readonly ok: boolean;
        readonly errors: readonly ConfigError[];
        readonly warnings: readonly ConfigWarning[];
      }>('/validate', { config: draft });
      setValidation({ errors: response.errors, warnings: response.warnings });
    } catch (errorValue) {
      setError(errorText(errorValue));
    }
  }, [draft]);

  const save = async (): Promise<void> => {
    if (state === null || draft === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await postJson('/config/save', {
        revision: state.fileRevision,
        config: draft,
      });
      setNotice('配置已保存并应用。');
      await load();
    } catch (errorValue) {
      setError(errorText(errorValue));
      if (errorValue instanceof ApiError && errorValue.status === 409) {
        setNotice('配置文件已被外部修改。请刷新后重新合并草稿；草稿未被覆盖。');
      }
      if (errorValue instanceof ApiError && errorValue.status === 422) {
        const payload = errorValue.payload;
        if (payload !== null && typeof payload === 'object') {
          const errors =
            (payload as { readonly errors?: readonly ConfigError[] }).errors ??
            [];
          setValidation((current) => ({ ...current, errors }));
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const publicKey = useMemo(
    () => (state === null ? '' : state.effectiveRevision),
    [state],
  );

  if (state === null || draft === null) {
    return (
      <div
        style={{
          padding: 24,
          fontSize: 13,
          color: 'var(--dsw-alias-label-secondary)',
        }}
      >
        {error === null
          ? '正在读取 Arbiter 配置…'
          : `无法读取 Arbiter 配置：${error}`}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Arbiter</div>
          <div
            style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}
          >
            配置修订 {publicKey}
            {state.documentPath === null ? '' : ` · ${state.documentPath}`}
            {dirty ? ' · 有未保存草稿' : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            onClick={() => {
              void validate();
            }}
            disabled={busy}
          >
            校验草稿
          </Button>
          <Button
            onClick={() => {
              void load();
            }}
            disabled={busy}
          >
            重新读取
          </Button>
          <Button
            onClick={() => {
              void save();
            }}
            disabled={busy || state.fileRevision === null}
            tone="primary"
          >
            {busy ? '处理中…' : '保存并应用'}
          </Button>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 4,
          borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
          flexWrap: 'wrap',
        }}
      >
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            style={{
              padding: '8px 12px',
              border: 0,
              borderBottom:
                tab === id
                  ? '2px solid var(--dsw-alias-state-business-primary)'
                  : '2px solid transparent',
              background: 'transparent',
              color:
                tab === id
                  ? 'var(--dsw-alias-label-primary)'
                  : 'var(--dsw-alias-label-secondary)',
              cursor: 'pointer',
              fontSize: 12.5,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {error === null ? null : <Notice kind="error" text={error} />}
      {notice === null ? null : <Notice kind="ok" text={notice} />}
      {validation.errors.length === 0 ? null : (
        <Notice
          kind="error"
          text={validation.errors
            .map((item) => `${item.path}: ${item.message}`)
            .join('\n')}
        />
      )}
      {validation.warnings.length === 0 ? null : (
        <Notice
          kind="info"
          text={validation.warnings
            .map((item) => `${item.path}: ${item.message}`)
            .join('\n')}
        />
      )}

      {tab === 'status' ? (
        <StatusPanel state={state} draft={draft} onDraft={onDraft} />
      ) : null}
      {tab === 'rules' ? <RulesPanel draft={draft} onDraft={onDraft} /> : null}
      {tab === 'reviewer' ? (
        <ReviewerPanel draft={draft} onDraft={onDraft} />
      ) : null}
      {tab === 'advanced' ? (
        <AdvancedPanel draft={draft} onDraft={onDraft} />
      ) : null}
      {tab === 'logs' ? <LogsPanel /> : null}
      {tab === 'suggestions' ? (
        <SuggestionsPanel
          onApplied={() => {
            void load();
          }}
        />
      ) : null}
      {tab === 'about' ? <AboutPanel state={state} /> : null}
    </div>
  );
}

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register(
      { name: 'plugins.bundle.config', key: 'dsh-arbiter' },
      ArbiterPage,
    ),
  );
}

export const inject = ['slots'];
