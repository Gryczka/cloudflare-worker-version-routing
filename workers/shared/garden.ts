export const PUBLIC_ORIGIN = "https://pin.gryczka.dev";

export function gardenUrl(raw: string): string {
	try {
		const url = new URL(raw);
		if (url.protocol !== "https:" || !/(^|\.)cloudflare\.com$/.test(url.hostname)) return raw;
		const resource = url.pathname.split("/").filter(Boolean).join("-") || "overview";
		url.searchParams.set("utm_source", "gryczka.dev");
		url.searchParams.set("utm_medium", "referral");
		url.searchParams.set("utm_campaign", "app-garden");
		url.searchParams.set("utm_content", `worker-version-pinning-${resource}`);
		url.searchParams.set("utm_term", "workers");
		return url.href;
	} catch { return raw; }
}

export function resourceAnchors(html: string): string {
	return html.replace(/(<a\b[^>]*\bhref=)(["'])([^"']+)\2/gi, (_match, prefix, quote, href) => `${prefix}${quote}${gardenUrl(href.replaceAll("&amp;", "&")).replaceAll("&", "&amp;")}${quote}`);
}

export function discovery(path: string): Response | null {
	const headers = { "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" };
	if (path === "/robots.txt") return new Response(`User-agent: *\nContent-Signal: search=yes,ai-input=yes,ai-train=no\nAllow: /\nDisallow: /api/\nDisallow: /health\nDisallow: /probe\nSitemap: ${PUBLIC_ORIGIN}/sitemap.xml\n`, { headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
	if (path === "/sitemap.xml") return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${PUBLIC_ORIGIN}/</loc></url></urlset>`, { headers: { ...headers, "content-type": "application/xml; charset=utf-8" } });
	return null;
}

/** Approximately 1% sampled, fixed-field logs. Never log bodies/errors/query strings. */
export function diagnosticLog(fields: Record<string, unknown>): void {
	if (crypto.getRandomValues(new Uint8Array(1))[0] >= 3) return;
	const keys = ["event", "traceId", "mode", "status", "callerVersionId", "targetVersionId", "versionId", "release"];
	const bounded = Object.fromEntries(keys.filter(key => key in fields).map(key => [key, typeof fields[key] === "string" ? fields[key].slice(0, 80) : typeof fields[key] === "number" ? fields[key] : null]));
	console.log(JSON.stringify(bounded));
}
