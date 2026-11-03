import { describe, expect, it } from 'vitest';
import { renderHtml } from '../../evals/src/report/html.js';
import {
  ATTACK_TEXT,
  BODY_CANARY,
  reportBrowserFixture,
} from './helpers/report-browser.js';

function rowsIn(html: string): readonly string[] {
  return [...html.matchAll(/<tr data-example[^>]*>(.*?)<\/tr>/gsu)].map(
    (match) => match[1] ?? '',
  );
}

describe('complete static HTML report', { timeout: 30_000 }, () => {
  it('retains all planned rows, statuses and distinct source controls in stable order', async () => {
    const fixture = await reportBrowserFixture();
    try {
      const html = await fixture.text('html');
      const rows = rowsIn(html);
      expect(rows).toHaveLength(8);
      expect(rows.map((row) => /<td>([^<]*)<\/td>/u.exec(row)?.[1])).toEqual(
        fixture.report.examples.map((cell) => cell.cellId),
      );
      expect(html).not.toContain('<tr data-example hidden');
      for (const cell of fixture.report.examples) {
        const row = rows.find((entry) =>
          entry.includes(`<td>${cell.cellId}</td>`),
        );
        expect(row).toContain(cell.status);
        expect(row).toContain(cell.classification);
      }
      expect([...html.matchAll(/data-filter=/gu)].length).toBe(5);
      expect(html).toContain('f02');
      expect(html).toContain('reconstructed');
      expect(html).toContain('data-controls hidden');
      expect(html).toContain('当前可见 8 / 全计划 8 格');
    } finally {
      await fixture.remove();
    }
  });

  it('keeps hostile stored model text escaped and excludes credential bodies in all formats', async () => {
    const fixture = await reportBrowserFixture('unsafe');
    try {
      const html = await fixture.text('html');
      expect(html).not.toMatch(/<(?:img|svg|iframe|link)\b/iu);
      expect([...html.matchAll(/<script\b/giu)].length).toBe(1);
      expect(html.split('<script>')[1]).not.toContain(ATTACK_TEXT);
      expect(html).toContain(
        '&lt;/script&gt;&lt;script&gt;globalThis.reportAttack = true&lt;/script&gt;',
      );
      expect(html).toContain('[redacted]');
      for (const format of ['json', 'md', 'html'] as const)
        expect(await fixture.text(format)).not.toContain(BODY_CANARY);
    } finally {
      await fixture.remove();
    }
  });

  it('renders historical callers without optional metadata and escapes filter attributes', async () => {
    const fixture = await reportBrowserFixture();
    try {
      const { publication, evidence, ...historical } = fixture.report;
      expect(publication).toBeDefined();
      expect(evidence).toHaveLength(8);
      const report = {
        ...historical,
        examples: historical.examples.map((cell) =>
          cell.source?.kind === 'workflow'
            ? {
                ...cell,
                rationale: ATTACK_TEXT,
                source: {
                  ...cell.source,
                  group: `" autofocus onfocus="${ATTACK_TEXT}`,
                },
              }
            : { ...cell, rationale: ATTACK_TEXT },
        ),
      };
      const html = renderHtml(report);
      expect(renderHtml(report)).toBe(html);
      expect(rowsIn(html)).toHaveLength(8);
      expect(html).not.toMatch(/<(?:img|svg)\b/iu);
      expect(html).toContain('&quot; autofocus onfocus=');
      expect(html).toContain('未提供材料公开视图');
      expect(html).toContain(
        '&lt;/script&gt;&lt;script&gt;globalThis.reportAttack = true&lt;/script&gt;',
      );
    } finally {
      await fixture.remove();
    }
  });
});
