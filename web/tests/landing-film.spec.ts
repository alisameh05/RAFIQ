import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { socialFixture } from './social-fixture';

const mode = process.env.RAFIQ_FILM_FIXTURE;
const origin = process.env.RAFIQ_LANDING_PENDING_ORIGIN;
const mediaPath = '/landing/film/';
const filmName = 'The RAFIQ film';
const playName = 'Play the RAFIQ film';

test.skip(!mode || !origin, 'Requires the isolated landing film configuration.');

async function fixtureMedia(page: Page, broken?: 'video' | 'captions') {
  const video = await readFile('tests/fixtures/landing-film.webm');
  await page.route('**/landing/film/poster.png', route => route.fulfill({ path: 'tests/fixtures/landing-film.png' }));
  await page.route('**/landing/film/fixture.vtt', route => broken === 'captions'
    ? route.fulfill({ status: 404 })
    : route.fulfill({ path: 'tests/fixtures/landing-film.vtt', contentType: 'text/vtt' }));
  await page.route('**/landing/film/fixture.webm', route => {
    if (broken === 'video') return route.fulfill({ status: 404 });

    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '');
    const contentType = 'video/webm';
    if (!range) return route.fulfill({ contentType, body: video });

    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), video.length - 1) : video.length - 1;
    return route.fulfill({
      status: 206, contentType,
      headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${video.length}` },
      body: video.subarray(start, end + 1),
    });
  });
}

async function tabToControl(page: Page, name: RegExp) {
  const session = await page.context().newCDPSession(page);
  const visited: string[] = [];
  try {
    for (let index = 0; index < 12; index += 1) {
      const { nodes } = await session.send('Accessibility.getFullAXTree');
      const focused = nodes.filter(node => node.properties?.some(prop => prop.name === 'focused' && prop.value.value === true));
      if (focused.some(node => name.test(node.name?.value ?? ''))) return;
      visited.push(focused.map(node => node.name?.value || node.role?.value).join('/'));
      await page.keyboard.press('Tab');
    }
    throw new Error('Could not reach control ' + name + '. Focus visited ' + visited.join(', '));
  } finally {
    await session.detach();
  }
}

test('a held release or either missing media input keeps the launch ending usable without graphics motion',
  async ({ page }, testInfo) => {
    test.skip(mode === 'ready');
    await socialFixture(page, 'google');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...attributes: unknown[]) {
        return type.startsWith('webgl') ? null : Reflect.apply(getContext, this, [type, ...attributes]);
      } as typeof getContext;
    });
    const mediaRequests: string[] = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith(mediaPath)) mediaRequests.push(request.url());
    });
    await page.goto(origin!);
    const join = page.getByRole('link', { name: 'Join RAFIQ' });
    await expect(join).toBeVisible();
    await expect(page.getByRole('button', { name: playName })).toHaveCount(0);
    await expect(page.locator('video')).toHaveCount(0);
    await join.focus();
    await expect(join).toHaveCSS('outline-style', 'solid');
    await page.screenshot({ path: testInfo.outputPath('film-launch.png') });
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new URL('/sign-up', origin!).href);
    await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible();
    expect(mediaRequests).toEqual([]);
  });

test('both media inputs reveal a poster and a named play action without loading the film', async ({ page }, testInfo) => {
  test.skip(mode !== 'ready');
  await fixtureMedia(page);
  const mediaRequests: string[] = [];
  page.on('request', request => {
    if (/\.(webm|vtt)$/.test(new URL(request.url()).pathname)) mediaRequests.push(request.url());
  });
  await page.goto(origin!);
  const film = page.getByRole('region', { name: filmName });
  const play = film.getByRole('button', { name: playName });
  await expect(play).toBeVisible();
  const poster = film.locator('img');
  await expect(poster).toBeVisible();
  await expect.poll(() => poster.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
  await expect(film.locator('video')).toHaveCount(0);
  await play.focus();
  await expect(play).toHaveCSS('outline-style', 'solid');
  await film.screenshot({ path: testInfo.outputPath('film-poster.png') });
  expect(mediaRequests).toEqual([]);
});

test('keyboard playback renders English WebVTT and leaves focus on Play when closed', async ({ page }, testInfo) => {
  test.skip(mode !== 'ready');
  await fixtureMedia(page);
  await page.goto(origin!);

  const film = page.getByRole('region', { name: filmName });
  const play = film.getByRole('button', { name: playName });
  const video = film.locator('video');
  const close = film.getByRole('button', { name: 'Close film' });
  const keyboard = page.keyboard;
  await play.focus();
  await keyboard.press('Enter');
  await expect(video).toBeFocused();
  await expect(video).toHaveJSProperty('controls', true);
  await expect(video).toHaveJSProperty('paused', false);
  await expect(video).toHaveJSProperty('autoplay', false);
  await expect(film.getByRole('status')).toHaveText('Film ready. English captions are available.');
  await expect(video.locator('track')).toHaveAttribute('srclang', 'en');
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) =>
    Array.from(element.textTracks[0].activeCues ?? [], cue => (cue as VTTCue).text))).toContain('[Silent test pattern]');
  await film.screenshot({ path: testInfo.outputPath('film-captioned-desktop.png') });

  await tabToControl(page, /^pause$/i);
  await keyboard.press('Space');
  await expect(video).toHaveJSProperty('paused', true);
  await keyboard.press('Space');
  await expect(video).toHaveJSProperty('paused', false);
  await keyboard.press('Space');
  await expect(video).toHaveJSProperty('paused', true);
  const before = await video.evaluate((element: HTMLVideoElement) => element.currentTime);
  await tabToControl(page, /video time/i);
  await keyboard.press('ArrowRight');
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(before);

  const captions = film.getByRole('button', { name: 'English captions' });
  await tabToControl(page, /^English captions$/i);
  await expect(captions).toHaveAttribute('aria-pressed', 'true');
  await keyboard.press('Space');
  await expect(captions).toHaveAttribute('aria-pressed', 'false');
  await expect(captions.getByText('Off', { exact: true })).toBeVisible();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.textTracks[0].mode)).toBe('disabled');
  await keyboard.press('Space');
  await expect(captions).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.textTracks[0].mode)).toBe('showing');

  await keyboard.press('Tab');
  await expect(close).toBeFocused();
  await keyboard.press('Enter');
  await expect(video).toHaveCount(0);
  await expect(play).toBeFocused();
  await keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Join RAFIQ' })).toBeFocused();
});

for (const [width, scale] of [[390, 1], [320, 1], [640, 2]]) {
  test(`film and account CTA reflow at ${width}px and ${scale * 100}% scale with reduced motion`, async ({ page }, testInfo) => {
    test.skip(mode !== 'ready');
    await page.setViewportSize({ width, height: 840 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await fixtureMedia(page);
    await page.goto(origin!);
    await page.locator('html').evaluate((node, zoom) => { node.style.zoom = String(zoom); }, scale);
    const film = page.getByRole('region', { name: filmName });
    const play = film.getByRole('button', { name: playName });
    await play.focus();
    await page.keyboard.press('Enter');
    await expect(film.locator('video')).toHaveJSProperty('controls', true);
    await expect(film.getByRole('button', { name: 'Close film' })).toBeVisible();
    await expect(film.getByRole('button', { name: 'English captions' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    if (width === 320 || scale === 2) {
      const label = scale === 2 ? 'film-captioned-200-percent.png' : 'film-captioned-320.png';
      await film.screenshot({ path: testInfo.outputPath(label) });
    }
    const video = film.locator('video');
    await expect(video).toHaveJSProperty('paused', false);
    await tabToControl(page, /^pause$/i);
    await page.keyboard.press('Space');
    await expect(video).toHaveJSProperty('paused', true);
    const before = await video.evaluate((element: HTMLVideoElement) => element.currentTime);
    await tabToControl(page, /video time/i);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(before);
    await expect(page.getByRole('link', { name: 'Join RAFIQ' })).toBeVisible();
  });
}

for (const broken of ['video', 'captions'] as const) {
  test(`a broken ${broken} request preserves Join and allows keyboard retry`, async ({ page }, testInfo) => {
    test.skip(mode !== 'ready');
    await fixtureMedia(page, broken);
    await page.goto(origin!);
    const film = page.getByRole('region', { name: filmName });
    await film.getByRole('button', { name: playName }).focus();
    await page.keyboard.press('Enter');
    await expect(film.getByRole('status')).toContainText(broken === 'video'
      ? 'The film could not be loaded' : 'English captions could not be loaded');
    await expect(film.locator('video')).toHaveCount(0);
    const retry = film.getByRole('button', { name: 'Retry film' });
    await expect(retry).toBeFocused();
    await page.keyboard.press('Tab');
    const join = page.getByRole('link', { name: 'Join RAFIQ' });
    await expect(join).toBeFocused();
    await expect(join).toHaveAttribute('href', '/sign-up');
    const ending = page.getByRole('region', { name: /your drive.*your story/i });
    await film.evaluate((node, bottom) => window.scrollBy(0, node.getBoundingClientRect().top - bottom), 40);
    await expect(ending).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`film-failure-${broken}.png`) });

    await page.unroute('**/landing/film/fixture.webm');
    await page.unroute('**/landing/film/fixture.vtt');
    await page.unroute('**/landing/film/poster.png');
    await fixtureMedia(page);
    await page.keyboard.press('Shift+Tab');
    await expect(retry).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(film.locator('video')).toHaveJSProperty('paused', false);
  });
}

test('a slow track leaves account entry reachable and releases the player on timeout', async ({ page }) => {
  test.skip(mode !== 'ready');
  await fixtureMedia(page);
  await page.clock.install();
  let releaseTrack!: () => void;
  const trackHold = new Promise<void>(resolve => { releaseTrack = resolve; });
  await page.route('**/landing/film/fixture.vtt', async route => {
    await trackHold;
    await route.fulfill({ path: 'tests/fixtures/landing-film.vtt', contentType: 'text/vtt' });
  });
  try {
    await page.goto(origin!);
    const film = page.getByRole('region', { name: filmName });
    await film.getByRole('button', { name: playName }).focus();
    await page.keyboard.press('Enter');
    await expect(film.getByRole('status')).toHaveText('Loading film and English captions…');
    await expect(film.locator('video')).toHaveJSProperty('paused', true);
    await expect(film.locator('video')).toHaveJSProperty('controls', false);
    await page.keyboard.press('Tab');
    await expect(film.getByRole('button', { name: 'Close film' })).toBeFocused();
    await page.keyboard.press('Tab');
    const join = page.getByRole('link', { name: 'Join RAFIQ' });
    await expect(join).toBeFocused();
    await page.clock.fastForward(20_001);
    await expect(film.getByRole('status')).toContainText('The film is taking too long to load');
    await expect(film.locator('video')).toHaveCount(0);
    await expect(film.getByRole('button', { name: 'Retry film' })).toBeVisible();
    await expect(join).toBeFocused();
  } finally {
    releaseTrack();
  }
});

test('a failed poster keeps account entry visible without a play control', async ({ page }) => {
  test.skip(mode !== 'ready');
  await page.route('**/landing/film/poster.png', route => route.fulfill({ status: 404 }));
  await page.goto(origin!);
  const film = page.getByRole('region', { name: filmName });
  await expect(film.getByRole('status')).toContainText('The film is currently unavailable');
  await expect(film.getByRole('button', { name: playName })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Join RAFIQ' })).toHaveAttribute('href', '/sign-up');
});

test('eligible media leaves the launch ending usable with scripting disabled', async ({ browser }) => {
  test.skip(mode !== 'ready');
  const page = await browser.newPage({ javaScriptEnabled: false });
  try {
    await fixtureMedia(page);
    await page.goto(origin!);
    await expect(page.getByRole('button', { name: playName })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Join RAFIQ' })).toHaveAttribute('href', '/sign-up');
  } finally {
    await page.close();
  }
});
