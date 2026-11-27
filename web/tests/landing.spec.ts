import { expect, test } from '@playwright/test';

const pending = process.env.RAFIQ_LANDING_PENDING_ORIGIN;
const enabled = process.env.RAFIQ_LANDING_ENABLED_ORIGIN;

test('the public landing explains eligibility and preserves sign-in while signup is held', async ({ page }, testInfo) => {
  test.skip(!pending, 'Set RAFIQ_LANDING_PENDING_ORIGIN to the account-entry app with signup held.');
  await page.goto(pending!);
  await expect(page.getByRole('heading', { name: 'See what RAFIQ sees.' })).toBeVisible();
  const header = page.getByRole('banner');
  await expect(header).toContainText('For adults 18 and older');
  await expect(header).toContainText('while stationary');
  await expect(header).toContainText('approved supervised procedure');
  await expect(header).toContainText('Public signup is pending release.');
  await expect(header.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');
  const ending = page.getByRole('region', { name: /your drive.*your story/i });
  await expect(ending).toContainText('Public signup is pending release.');
  await expect(ending.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');
  await expect(page.getByRole('link', { name: /create account|join rafiq/i })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('pending-desktop.png'), fullPage: true });
  await page.goto(new URL('/sign-up', pending).href);
  await expect(page).toHaveURL(new URL('/', pending).href);
  await expect(header.getByText('Public signup is pending release.')).toBeVisible();
});

test('both join actions navigate to the real signup form', async ({ page }, testInfo) => {
  test.skip(!enabled, 'Set RAFIQ_LANDING_ENABLED_ORIGIN to an isolated Clerk development app with signup enabled.');
  await page.goto(enabled!);
  await page.screenshot({ path: testInfo.outputPath('enabled-desktop.png'), fullPage: true });
  for (const name of ['Create account', 'Join RAFIQ']) {
    const join = page.getByRole('link', { name, exact: true });
    await join.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new URL('/sign-up', enabled).href);
    await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible();
    await page.goto(enabled!);
  }
  await page.getByRole('banner').getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new URL('/sign-in', enabled).href);
  await expect(page.getByRole('button', { name: /continue/i }).first()).toBeVisible();
});

test('sample evidence supports keyboard and pointer review with exact source facts', async ({ page }) => {
  test.skip(!pending, 'Requires the pending account-entry app.');
  await page.goto(pending!);
  await expect(page.getByRole('img', { name: /staged driver.*parked vehicle/i })).toBeVisible();
  const timeline = page.getByRole('group', { name: 'Sample session timeline' });
  const pause = timeline.getByRole('button', { name: 'Pause' });
  const warning = timeline.getByRole('button', { name: 'Warning' });
  const timelineStatus = page.getByRole('article', { name: 'What happened in my session?' }).getByRole('status');
  const warningStatus = timelineStatus.filter({ hasText: '00:08' });
  await expect(warningStatus).toHaveText(/00:08 · Warning.*Drowsiness observed.*Eyes closed for 2 seconds/s);
  await pause.focus();
  await page.keyboard.press('Space');
  await expect(pause).toHaveAttribute('aria-pressed', 'true');
  await expect(timelineStatus)
    .toHaveText(/00:16 · Pause.*Monitoring paused.*camera view became obstructed/s);
  await expect(page.getByRole('img', { name: 'The staged camera view is obscured' })).toBeVisible();
  await warning.click();
  await expect(warningStatus).toBeVisible();

  const chart = page.getByRole('group', { name: 'Eye-closure warnings by session' });
  for (const name of ['Session 1 0', 'Session 2 2', 'This session 1']) {
    await expect(chart.getByRole('button', { name, exact: true })).toBeVisible();
  }
  const second = chart.getByRole('button', { name: /Session 2/ });
  await second.focus();
  await page.keyboard.press('Enter');
  await expect(second).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('status').filter({ hasText: 'Session 2' })).toHaveText('Session 2 recorded two eye-closure warnings.');

  const trigger = page.getByRole('button', { name: 'Open sample report' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const report = page.getByRole('dialog', { name: 'Parked session review' });
  await expect(report).toBeVisible();
  await expect(report.getByRole('button', { name: 'Close report' })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await expect(report.getByText(/Parked session, 00:08.*00:16/)).toBeVisible();
  await report.getByText('Two of three sessions included a warning', { exact: true }).click();
  await expect(report.getByText(/0 in session 1, 2 in session 2, and 1 in the parked session/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(report).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await report.getByRole('button', { name: 'Close report' }).click();
  await expect(trigger).toBeFocused();
});

test('narrow layout and 200% layout zoom reflow long content', async ({ page }, testInfo) => {
  test.skip(!pending, 'Requires the pending account-entry app.');
  for (const [width, zoom] of [[390, 1], [320, 1], [640, 2]]) {
    await page.setViewportSize({ width, height: 840 });
    await page.goto(pending!);
    await page.locator('html').evaluate((root, scale) => { root.style.zoom = String(scale); }, zoom);
    await page.getByText('Review the moments that mattered, privately.').evaluate((paragraph) => {
      paragraph.append(' ', 'A-long-eligibility-or-release-message-without-spaces-'.repeat(4));
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.getByRole('button', { name: 'Open sample report' }).click();
    const report = page.getByRole('dialog', { name: 'Parked session review' });
    await expect(report).toBeInViewport();
    await report.getByRole('button', { name: 'Close report' }).click();
    await expect(page.getByRole('region', { name: /your drive.*your story/i }).getByRole('link', { name: 'Sign in' })).toBeVisible();
    if (width === 320) await page.screenshot({ path: testInfo.outputPath('pending-320.png'), fullPage: true });
  }
});

test('graphics failure and reduced motion preserve the still, facts and controls', async ({ page }, testInfo) => {
  test.skip(!pending, 'Requires the pending account-entry app.');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...attributes: unknown[]) {
      return type.startsWith('webgl') ? null : Reflect.apply(getContext, this, [type, ...attributes]);
    } as typeof getContext;
  });
  // Exercise the actual turntable request with WebGL disabled.
  await page.route('**/landing/turntable/*.webp', (route) => route.abort());
  await page.goto(pending!);
  const failedAsset = page.waitForEvent('requestfailed', (request) => request.url().includes('/landing/turntable/'));
  await page.getByRole('heading', { name: 'RAFIQ Agent' }).scrollIntoViewIfNeeded();
  await failedAsset;
  await expect(page.getByRole('img', { name: /Miibot, the graphite RAFIQ companion/ })).toHaveCSS('opacity', '1');
  await expect(page.getByRole('img', { name: /Miibot, the graphite RAFIQ companion/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('turntable-failure.png') });

  await page.unroute('**/landing/turntable/*.webp');
  await page.reload();
  await page.getByRole('heading', { name: 'RAFIQ Agent' }).scrollIntoViewIfNeeded();
  const still = page.getByRole('img', { name: /Miibot, the graphite RAFIQ companion/ });
  await expect(still).toHaveCSS('opacity', '0');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(still).toHaveCSS('opacity', '1');
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('status').filter({ hasText: '00:16' })).toContainText('Monitoring paused');
  await expect(page.getByRole('region', { name: /your drive.*your story/i }).getByRole('link', { name: 'Sign in' })).toBeVisible();
});

test.describe('static HTML', () => {
  test.use({ javaScriptEnabled: false });

  test('the sample report and account controls remain readable without enhancement', async ({ page }) => {
    test.skip(!pending, 'Requires the pending account-entry app.');
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(pending!);
    await expect(page.getByText('The camera view became obstructed at 00:16.')).toBeVisible();
    await page.getByText('Open sample report', { exact: true }).filter({ visible: true }).click();
    await page.getByText('Two of three sessions included a warning', { exact: true }).filter({ visible: true }).click();
    await expect(page.getByText(/0 in session 1, 2 in session 2, and 1 in the parked session/).filter({ visible: true })).toBeVisible();
    await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');
  });
});
