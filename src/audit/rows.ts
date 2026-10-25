import { createHash } from 'node:crypto';
import type { ReviewSignals, TraceStage } from '../types.js';
export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function rowText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value);
  return fallback;
}

export function rowNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function rowJson(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return null;
  }
}

export function rowStrings(value: unknown): string[] {
  const parsed = rowJson(value);
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function rowTrace(value: unknown): TraceStage[] {
  const parsed = rowJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is TraceStage =>
      isRecord(entry) &&
      typeof entry['stage'] === 'string' &&
      typeof entry['result'] === 'string' &&
      typeof entry['at'] === 'number',
  );
}

export function rowDistribution(
  value: unknown,
): Readonly<Record<string, number>> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return null;
    out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function rowSignals(value: unknown): ReviewSignals | null {
  const parsed = rowJson(value);
  if (!isRecord(parsed)) return null;
  if (parsed['source'] !== 'chat' && parsed['source'] !== 'decision')
    return null;
  const riskClass = parsed['riskClass'];
  const authClass = parsed['authClass'];
  if (riskClass !== 'low' && riskClass !== 'medium' && riskClass !== 'high')
    return null;
  if (
    authClass !== 'none' &&
    authClass !== 'implied' &&
    authClass !== 'explicit'
  )
    return null;
  return {
    riskDist: rowDistribution(parsed['riskDist']),
    riskPoint:
      typeof parsed['riskPoint'] === 'number' ? parsed['riskPoint'] : null,
    riskScore:
      typeof parsed['riskScore'] === 'number' ? parsed['riskScore'] : null,
    riskClass,
    authDist: rowDistribution(parsed['authDist']),
    authPoint:
      typeof parsed['authPoint'] === 'number' ? parsed['authPoint'] : null,
    authClass,
    secrets: parsed['secrets'] === true,
    destructive: parsed['destructive'] === true,
    egress: parsed['egress'] === true,
    bulk: parsed['bulk'] === true,
    source: parsed['source'],
    repairs: typeof parsed['repairs'] === 'number' ? parsed['repairs'] : 0,
  };
}

export function rowChanges(value: unknown): number {
  return isRecord(value) ? rowNumber(value['changes']) : 0;
}

export function asRow(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
