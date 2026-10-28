import { expect, type Page } from '@playwright/test';

/**
 * Dismiss the native getting-started prompt.
 *
 * A credential-free profile presents this prompt on initial load/reload, and the
 * default contract asserts it so a missing prompt is a real host change. A
 * profile that already offers a usable model route may skip the prompt
 * entirely; `optional` accepts that composition and still dismisses the prompt
 * through its own button when it does appear.
 */
export async function dismissGettingStarted(
  page: Page,
  options: { readonly optional?: boolean } = {},
): Promise<void> {
  const gettingStarted = page.getByRole('dialog', {
    name: /开始使用|Get started/i,
  });
  if (options.optional !== true) {
    await expect(gettingStarted).toBeVisible();
    await gettingStarted
      .getByRole('button', { name: /^(关闭|Close)$/ })
      .click();
    return;
  }
  // Either the prompt or the manager chrome settles first; whichever arrives
  // decides whether there is anything to dismiss.
  await expect(
    gettingStarted.or(page.getByRole('button', { name: /^(插件|Plugins)$/ })),
  ).toBeVisible();
  if (!(await gettingStarted.isVisible())) return;
  await gettingStarted.getByRole('button', { name: /^(关闭|Close)$/ }).click();
  await expect(gettingStarted).toBeHidden();
}

/**
 * Start a new Session through the host's own sidebar control and wait until it
 * is the conversation the composer is attached to.
 *
 * Clicking *New session* only starts a navigation: the host resolves a blank
 * Session over `POST /api/session/create` before the composer changes owner. The
 * composer element itself is already present and editable while the previous
 * Session is still shown, so waiting for it to be visible proves nothing — a
 * prompt typed at that moment is sent to the *old* Session. A real failure in
 * `agent-guidance.spec.ts` was exactly this: the create request took 515ms, the
 * prompt went out 213ms after the click, and the turn landed in the session the
 * case had just left.
 *
 * Two observable facts delimit the switch, so neither a fixed delay nor a
 * guessed network call is involved:
 * - the create response names the Session the host actually resolved (it may
 *   reuse an existing blank, so the id is not assumed to be new); and
 * - the conversation root carries that id in `data-conversation-session`, which
 *   is the attribute the host itself uses to find the owning Session for a
 *   keyboard gesture.
 *
 * The response is awaited through a predicate rather than a race, so a create
 * issued by the initial page load cannot be mistaken for this click's.
 */
export async function startNewSession(page: Page): Promise<string> {
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/session/create' &&
      response.request().method() === 'POST' &&
      response.status() === 200,
  );
  await page
    .getByRole('button', { name: '新建会话', exact: true })
    .first()
    .click();
  const response = await created;
  const body: unknown = await response.json();
  const sessionId = sessionIdOfCreateResponse(body);
  await expect(
    page.locator(`[data-conversation-session="${sessionId}"]`),
  ).toBeVisible();
  return sessionId;
}

/** The Session id the host resolved from one create response. */
function sessionIdOfCreateResponse(body: unknown): string {
  const value = resultValue(body);
  const sessionId = value['sessionId'];
  if (typeof sessionId !== 'string' || sessionId.length === 0)
    throw new Error(
      `create response carried no session id: ${JSON.stringify(body)}`,
    );
  return sessionId;
}

/** The `result.value` record of one host RPC response. */
function resultValue(body: unknown): Record<string, unknown> {
  const result = recordAt(body, 'result');
  const value = result === null ? null : recordAt(result, 'value');
  if (value === null)
    throw new Error(`not a host RPC response: ${JSON.stringify(body)}`);
  return value;
}

/** One record-valued property, or null when it is absent or not a record. */
function recordAt(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const found: unknown = value[key];
  return isRecord(found) ? found : null;
}

/** Narrow an unknown value to a plain record without asserting. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Native manager navigation, shared by fresh loads and browser refresh cases. */
export async function openArbiterConfiguration(page: Page): Promise<void> {
  const pluginManager = page.getByRole('button', { name: /^(插件|Plugins)$/ });
  await expect(pluginManager).toBeVisible();
  await pluginManager.click();
  const pluginDetail = page.getByRole('button', {
    name: /^(查看|View) dsh-arbiter$/,
  });
  await expect(pluginDetail).toBeVisible();
  await pluginDetail.click();
}
