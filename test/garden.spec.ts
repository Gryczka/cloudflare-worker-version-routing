import { describe, expect, it } from 'vitest';
import { discovery, gardenUrl, resourceAnchors } from '../workers/shared/garden';

describe('public discovery contract', () => {
  it('preserves URL query parameters/fragments and decorates resource anchors only', () => {
    const raw = 'https://developers.cloudflare.com/workers/?lang=en#versions';
    const url = new URL(gardenUrl(raw));
    expect(url.searchParams.get('lang')).toBe('en');
    expect(url.hash).toBe('#versions');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ utm_source: 'gryczka.dev', utm_medium: 'referral', utm_campaign: 'app-garden', utm_content: 'worker-version-pinning-workers', utm_term: 'workers' });
    expect(resourceAnchors(`<a href="${raw}">Docs</a><code>${raw}</code>`)).toContain(`<code>${raw}</code>`);
  });
  it('excludes active probes from discovery', async () => {
    expect(await discovery('/robots.txt')!.text()).toContain('Content-Signal: search=yes,ai-input=yes,ai-train=no');
    expect(await discovery('/robots.txt')!.text()).toContain('Disallow: /probe');
    expect(await discovery('/sitemap.xml')!.text()).not.toContain('/probe');
  });
});
