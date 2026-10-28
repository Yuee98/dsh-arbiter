import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { localeResources } from '../../src/client/i18n/resources.js';
import { ArbiterPage } from '../../src/client/index.js';
import { setupApiMock } from '../helpers/api-mock.js';
import { effectiveState } from '../helpers/client-state.js';
import { renderClient } from '../helpers/render-client.js';

const server = setupApiMock();

function baseHandlers(): void {
  server.use(
    http.get('*/api/arbiter/state', () => HttpResponse.json(effectiveState())),
    http.post('*/api/arbiter/validate', () =>
      HttpResponse.json({ ok: true, errors: [], warnings: [] }),
    ),
  );
}

describe('circuit-breaker explanation contract and dynamic settings', () => {
  test('locale resource strings accurately describe the 1-hour accumulated blocking events and 30-minute window without claiming consecutive operations or windowSize call window', () => {
    const zh = localeResources.zh.advanced;
    const en = localeResources.en.advanced;

    // Both locales must contain consecutive and windowDenials placeholders
    expect(zh.breakerHelpTripped).toContain('{consecutive}');
    expect(zh.breakerHelpTripped).toContain('{windowDenials}');
    expect(en.breakerHelpTripped).toContain('{consecutive}');
    expect(en.breakerHelpTripped).toContain('{windowDenials}');

    // Neither locale may claim that windowSize controls runtime rolling calls
    expect(zh.breakerHelpTripped).not.toContain('{windowSize}');
    expect(zh.breakerHelpTripped).not.toContain('审查窗口');
    expect(en.breakerHelpTripped).not.toContain('{windowSize}');
    expect(en.breakerHelpTripped).not.toContain('call window');

    // Neither locale may claim the first threshold requires consecutive denied operations
    expect(zh.breakerHelpTripped).not.toContain('连续');
    expect(en.breakerHelpTripped.replace('{consecutive}', '')).not.toContain(
      'consecutive',
    );

    // Both locales must accurately reflect the 1-hour and 30-minute timestamp windows
    expect(zh.breakerHelpTripped).toContain('1 小时');
    expect(zh.breakerHelpTripped).toContain('30 分钟');
    expect(en.breakerHelpTripped).toContain('1 hour');
    expect(en.breakerHelpTripped).toContain('30 minutes');

    // Both locales must state blocking events (including denials and aborted approvals)
    expect(zh.breakerHelpTripped).toContain('阻断事件');
    expect(en.breakerHelpTripped).toContain('blocking events');

    // Both locales must state approval reset
    expect(zh.breakerHelpTripped).toContain('放行后重置');
    expect(en.breakerHelpTripped).toContain('reset on approval');

    expect(zh.breakerHelpOff).not.toContain('连续');
    expect(en.breakerHelpOff).not.toContain('consecutive');
  });

  test('UI reflects dynamic thresholds across presets, custom inputs, and disabled mode in Chinese', async () => {
    baseHandlers();
    const { user } = renderClient(<ArbiterPage />);

    await user.click(await screen.findByRole('button', { name: '策略与高级' }));
    await screen.findByRole('heading', { name: '审计与熔断' });

    // 1. Default balanced preset: 3 events in 1 hour, 6 in 30 minutes
    expect(
      screen.getByText(
        '当 1 小时内累计记录 3 次阻断事件（含拒绝与放弃审批），或 30 分钟内累计达 6 次时，将触发熔断保护并暂停自动放行；审查或人工放行后重置。',
      ),
    ).toBeInTheDocument();

    const breakerSelect = screen.getByLabelText('熔断模式');

    // 2. Strict preset: 2 in 1 hour, 4 in 30 minutes
    await user.selectOptions(breakerSelect, 'strict');
    expect(
      screen.getByText(
        '当 1 小时内累计记录 2 次阻断事件（含拒绝与放弃审批），或 30 分钟内累计达 4 次时，将触发熔断保护并暂停自动放行；审查或人工放行后重置。',
      ),
    ).toBeInTheDocument();

    // 3. Lenient preset: 5 in 1 hour, 10 in 30 minutes
    await user.selectOptions(breakerSelect, 'lenient');
    expect(
      screen.getByText(
        '当 1 小时内累计记录 5 次阻断事件（含拒绝与放弃审批），或 30 分钟内累计达 10 次时，将触发熔断保护并暂停自动放行；审查或人工放行后重置。',
      ),
    ).toBeInTheDocument();

    // 4. Custom mode with customized thresholds
    await user.selectOptions(breakerSelect, 'custom');
    const consecutiveInput = screen.getByLabelText('连续拒绝');
    const windowDenialsInput = screen.getByLabelText('窗口内拒绝');

    await user.clear(consecutiveInput);
    await user.type(consecutiveInput, '7');
    await user.clear(windowDenialsInput);
    await user.type(windowDenialsInput, '12');

    expect(
      screen.getByText(
        '当 1 小时内累计记录 7 次阻断事件（含拒绝与放弃审批），或 30 分钟内累计达 12 次时，将触发熔断保护并暂停自动放行；审查或人工放行后重置。',
      ),
    ).toBeInTheDocument();

    // 5. Off mode
    await user.selectOptions(breakerSelect, 'off');
    expect(
      screen.getByText('熔断保护已关闭，阻断事件不会自动暂停自动放行。'),
    ).toBeInTheDocument();
  });

  test('UI reflects dynamic thresholds and accurate explanations in English', async () => {
    baseHandlers();
    const { user } = renderClient(<ArbiterPage />, {
      locale: 'en',
    });

    await user.click(
      await screen.findByRole('button', { name: 'Policy and advanced' }),
    );
    await screen.findByRole('heading', { name: 'Audit and circuit breaker' });

    // Default balanced preset
    expect(
      screen.getByText(
        'Trips circuit breaker protection when 3 blocking events (denials or aborted approvals) accumulate within 1 hour, or 6 within 30 minutes, pausing auto-approvals; reset on approval.',
      ),
    ).toBeInTheDocument();

    const breakerSelect = screen.getByLabelText('Circuit breaker mode');

    // Custom mode
    await user.selectOptions(breakerSelect, 'custom');
    const consecutiveInput = screen.getByLabelText('Consecutive denials');
    const windowDenialsInput = screen.getByLabelText('Denials within a window');

    await user.clear(consecutiveInput);
    await user.type(consecutiveInput, '9');
    await user.clear(windowDenialsInput);
    await user.type(windowDenialsInput, '15');

    expect(
      screen.getByText(
        'Trips circuit breaker protection when 9 blocking events (denials or aborted approvals) accumulate within 1 hour, or 15 within 30 minutes, pausing auto-approvals; reset on approval.',
      ),
    ).toBeInTheDocument();

    // Off mode
    await user.selectOptions(breakerSelect, 'off');
    expect(
      screen.getByText(
        'Circuit breaker protection is disabled; recorded blocking events will not trip automated gating.',
      ),
    ).toBeInTheDocument();
  });
});
