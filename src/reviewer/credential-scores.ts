/** Score exceptions belong to protocol positions, never to a field name alone. */
import { PROBE_OPTIONS } from './probe.js';

type Role =
  | 'chat'
  | 'pair'
  | 'answer'
  | 'question'
  | 'levels'
  | 'legend'
  | 'request'
  | 'chat-request'
  | 'envelope';
const PAIR_KEYS = new Set(['risk', 'authorization', 'recoverability']);
const ANSWER_KEYS = new Set([
  'type',
  'probabilities',
  'score',
  'legend',
  'confidence',
]);
const QUESTION_KEYS = new Set(['type', 'instructions', 'criteria']);
const REQUEST_KEYS = new Set(['model', 'state', 'questions', 'input']);
const CHAT_REQUEST_KEYS = new Set(['provider', 'model', 'system', 'messages']);
const ENVELOPE_KEYS = new Set([
  'model',
  'answers',
  'result',
  'usage',
  'success',
  'errors',
  'messages',
]);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function band(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 10
  );
}
function answer(value: unknown): value is Record<string, unknown> {
  return object(value) && object(value['probabilities']);
}
function question(value: unknown): boolean {
  return (
    object(value) &&
    value['type'] === 'score' &&
    typeof value['instructions'] === 'string' &&
    Array.isArray(value['criteria']) &&
    value['criteria'].every((item: unknown) => typeof item === 'string')
  );
}
function questions(value: unknown): value is Record<string, unknown> {
  return (
    object(value) && question(value['risk']) && question(value['authorization'])
  );
}
export class CredentialScoreContext {
  readonly #roles = new Map<string, Role>();
  constructor(value: unknown, enabled: boolean) {
    if (!enabled || !object(value)) return;
    this.initializeAnswers(value);
    this.initializeRequests(value);
  }
  private initializeAnswers(value: Record<string, unknown>): void {
    if (band(value['risk']) && band(value['authorization']))
      this.set([], 'chat');
    // Root score-object fragments remain readable; nested errors get no role.
    if (
      (answer(value['risk']) && answer(value['authorization'])) ||
      (answer(value['authorization']) &&
        value['authorization']['type'] === 'score')
    )
      this.answers([], value);
    const result = value['result'];
    // Match the current envelope's result.answers precedence, including failures.
    if (object(result) && object(result['answers'])) {
      this.set([], 'envelope');
      this.set(['result'], 'envelope');
      this.answers(['result', 'answers'], result['answers']);
    } else if (object(value['answers'])) {
      this.set([], 'envelope');
      this.answers(['answers'], value['answers']);
    }
  }
  private initializeRequests(value: Record<string, unknown>): void {
    if (questions(value)) this.questionPair([], value);
    this.request(value, []);
    if (object(value['input'])) this.request(value['input'], ['input']);
    if (typeof value['system'] === 'string' && Array.isArray(value['messages']))
      this.set([], 'chat-request');
  }
  get active(): boolean {
    return this.#roles.size > 0;
  }
  private set(path: readonly string[], role: Role): void {
    this.#roles.set(JSON.stringify(path), role);
  }
  private role(path: readonly string[]): Role | undefined {
    return this.#roles.get(JSON.stringify(path));
  }
  private answers(
    path: readonly string[],
    value: Record<string, unknown>,
  ): void {
    this.set(path, 'pair');
    for (const key of ['risk', 'authorization']) {
      const item = value[key];
      if (!answer(item)) continue;
      this.set([...path, key], 'answer');
      this.set([...path, key, 'probabilities'], 'levels');
      if (object(item['legend'])) this.set([...path, key, 'legend'], 'legend');
    }
  }
  private questionPair(
    path: readonly string[],
    value: Record<string, unknown>,
  ): void {
    this.set(path, 'pair');
    for (const key of PAIR_KEYS) {
      const item = value[key];
      if (
        question(item) ||
        (object(item) &&
          item['type'] === 'choice' &&
          typeof item['instructions'] === 'string')
      )
        this.set([...path, key], 'question');
    }
  }
  private request(
    value: Record<string, unknown>,
    path: readonly string[],
  ): void {
    const item = value['questions'];
    if (!questions(item)) return;
    this.set(path, 'request');
    if (path.length > 0) this.set([], 'request');
    this.questionPair([...path, 'questions'], item);
  }
  numeric(path: readonly string[]): boolean {
    return (
      path.length === 1 &&
      path[0] === 'authorization' &&
      this.role([]) === 'chat'
    );
  }
  key(path: readonly string[], key: string): boolean {
    const role = this.role(path);
    if (role === 'chat' || role === 'pair') return PAIR_KEYS.has(key);
    if (role === 'answer') return ANSWER_KEYS.has(key);
    if (role === 'question') return QUESTION_KEYS.has(key);
    if (role === 'levels' || role === 'legend') return /^[0-9]$/u.test(key);
    if (role === 'request') return REQUEST_KEYS.has(key);
    if (role === 'envelope') return ENVELOPE_KEYS.has(key);
    return role === 'chat-request' && CHAT_REQUEST_KEYS.has(key);
  }
  literal(path: readonly string[], value: string): boolean {
    const parent = this.role(path.slice(0, -1));
    const key = path.at(-1);
    if ((parent === 'answer' || parent === 'question') && key === 'type')
      return value === 'score' || (parent === 'question' && value === 'choice');
    return (
      (parent === 'chat' || parent === 'pair') &&
      key === 'recoverability' &&
      PROBE_OPTIONS.some((option) => value.trim().toLowerCase() === option)
    );
  }
  extra(path: readonly string[], key: string, value: unknown): boolean {
    const role = this.role(path);
    if (role === 'levels')
      return (
        !/^[0-9]$/u.test(key) ||
        typeof value !== 'number' ||
        !Number.isFinite(value)
      );
    if (role === 'legend')
      return !/^[0-9]$/u.test(key) || typeof value !== 'string';
    if (role !== 'answer') return false;
    if (!ANSWER_KEYS.has(key)) return true;
    if (key === 'confidence' || key === 'score')
      return typeof value !== 'number' || !Number.isFinite(value);
    if (key === 'legend') return typeof value !== 'string' && !object(value);
    if (key === 'probabilities') return !object(value);
    return key === 'type' && value !== 'score';
  }

  system(path: readonly string[]): boolean {
    return (
      path.length === 1 &&
      path[0] === 'system' &&
      this.role([]) === 'chat-request'
    );
  }
  member(path: readonly string[]): boolean {
    const role = this.role(path);
    return role === 'answer' || role === 'question';
  }
}
