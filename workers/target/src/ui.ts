/** Interactive, read-only walkthrough of Worker-to-Worker version routing. */

interface VersionEntry {
	release: string;
	id: string;
}

interface UiConfig {
	worker: string;
	version: string;
	targetOrigin: string;
	callerOrigin: string;
	workersDevSubdomain: string;
	candidateVersionId: string;
	labVersions: VersionEntry[];
}

/** Renders the target's self-contained diagnostic interface. */
export function renderPage(config: UiConfig): string {
	const data = JSON.stringify(config).replaceAll("<", "\\u003c");
	const versionHost = `${config.worker}.${config.workersDevSubdomain}.workers.dev`;
	const candidate = config.candidateVersionId;
	const latestLab = config.labVersions.at(-1);
	const candidateCards = candidate ? `
<article class="card"><div class="top"><span class="label alt">Fixed Version URL</span><span class="dot" aria-hidden="true"></span></div><h3>0% candidate</h3><p>Reach the candidate by its own URL, independent of its production traffic allocation.</p><code class="address">${candidate.slice(0, 8)}-${escapeHtml(versionHost)}</code><div class="actions"><button type="button" class="btn" data-query="uploaded=${candidate}" data-version="${candidate}" data-release="candidate">Fixed URL →</button><button type="button" class="btn secondary" data-query="version=${candidate}" data-version="${candidate}">Service override</button></div></article>
<article class="card"><div class="top"><span class="label alt">Moving Alias</span><span class="dot" aria-hidden="true"></span></div><h3>Candidate alias</h3><p>The readable alias follows whichever uploaded version was most recently assigned the candidate name.</p><code class="address">candidate-${escapeHtml(versionHost)}</code><div class="actions"><button type="button" class="btn" data-query="alias=candidate" data-version="${candidate}" data-release="candidate">Worker fetch →</button></div></article>` : `
<article class="card"><div class="top"><span class="label alt">Setup required</span></div><h3>Upload versions</h3><p>Run the bootstrap command to create the 0% candidate and ten fixed lab versions, then redeploy this UI with their generated IDs.</p><code class="address">npm run bootstrap</code></article>`;
	const aliasCard = latestLab ? `
<article class="card"><div class="top"><span class="label alt">Moving Alias</span><span class="dot" aria-hidden="true"></span></div><h3>${escapeHtml(latestLab.release)} alias</h3><p>This readable workers.dev alias currently points to the latest labeled lab upload.</p><code class="address">${escapeHtml(latestLab.release)}-${escapeHtml(versionHost)}</code><div class="actions"><button type="button" class="btn" data-query="alias=${escapeHtml(latestLab.release)}" data-version="${latestLab.id}" data-release="${escapeHtml(latestLab.release)}">Worker fetch →</button></div></article>` : "";
	const versionRows = config.labVersions.map(({ release, id }) => `
<div class="version-item"><strong>${escapeHtml(release)}</strong><code>${id.slice(0, 8)}-${escapeHtml(versionHost)}</code><button type="button" class="btn secondary" data-query="uploaded=${id}" data-version="${id}" data-release="${escapeHtml(release)}" aria-label="Fetch ${escapeHtml(release)} through the caller Worker">Call →</button></div>`).join("");

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="Fetch individually addressable Worker versions over HTTP from another Cloudflare Worker.">
<title>One Worker, Many Versions | Cloudflare demo</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#19221d;background:#f6f7f1;font-synthesis:none}
*{box-sizing:border-box}body{margin:0}button,a,input{font:inherit}a{color:inherit}.wrap{max-width:1152px;margin:auto;padding:0 24px}.mast{border-bottom:1px solid #dde3d7;background:#fff}.mast .wrap{min-height:64px;display:flex;align-items:center;justify-content:space-between;gap:12px}.brand{font-size:14px;font-weight:800;letter-spacing:-.025em}.brand i{display:inline-block;width:12px;height:12px;border-radius:4px;background:#f48120;transform:rotate(18deg);margin-right:10px}.mast small{color:#617265;font-weight:600}
main{padding:48px 24px 80px!important}.eyebrow{color:#20764a;font-size:12px;text-transform:uppercase;letter-spacing:.16em;font-weight:800}.hero{max-width:820px}.hero h1{font-size:clamp(40px,5vw,64px);line-height:1.06;letter-spacing:-.055em;margin:16px 0 18px}.hero p{font-size:18px;line-height:1.65;color:#52645a;margin:0}.chips{display:flex;flex-wrap:wrap;gap:10px;margin:28px 0 48px}.chip{font-size:12px;font-weight:700;padding:8px 11px;border-radius:100px;background:#e7ede6;color:#385648}
.section-heading{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:17px}.section-heading h2{font-size:24px;letter-spacing:-.035em;margin:0}.section-heading span{font-size:13px;color:#66786b}.map{background:#132c22;color:#e9f5e9;border-radius:20px;padding:30px;margin-bottom:44px;box-shadow:0 18px 38px #18382718}.map h2{font-size:16px;margin:0 0 24px;color:#a3dac0}.flow{display:grid;grid-template-columns:1fr 1fr;gap:12px}.node{padding:18px;border-radius:12px;background:#214232;border:1px solid #426751;min-height:112px}.node small{display:block;color:#acd1b9;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;margin-bottom:11px}.node strong{display:block;font-size:16px}.node p{font-size:12px;color:#c6dfd1;margin:7px 0 0}.map .hint{margin:20px 0 0;color:#b5d5c1;font-size:12px}
.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.card{background:#fff;border:1px solid #dee7da;border-radius:16px;padding:22px;display:flex;flex-direction:column;min-height:286px;box-shadow:0 7px 22px #283c2808}.card .top{display:flex;align-items:center;justify-content:space-between;gap:10px}.label{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.09em;color:#267747}.label.alt{color:#aa6a1d}.dot{height:8px;width:8px;border-radius:50%;background:#55ae70}.card h3{font-size:22px;letter-spacing:-.04em;margin:19px 0 6px}.card p{color:#607166;font-size:13px;line-height:1.55;margin:0 0 20px}.address{display:block;border-radius:8px;background:#f4f7f1;padding:11px;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#30523c;margin-top:auto}.actions{display:flex;flex-wrap:wrap;align-items:center;gap:9px;margin-top:18px}.btn{border:1px solid #236a43;background:#246f46;color:#fff;text-decoration:none;border-radius:8px;padding:9px 13px;cursor:pointer;font-size:12px;font-weight:750}.btn:hover{background:#1c5636}.btn.secondary{background:#fff;color:#286846;border-color:#a9c8b2}.btn.secondary:hover{background:#eff8f0}.btn:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #f48120;outline-offset:2px}
.picker{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-top:22px}.picker label{font-size:13px;font-weight:700}.picker input{flex:1;min-width:230px;border:1px solid #a9c8b2;border-radius:8px;padding:9px 13px;font:13px ui-monospace,SFMono-Regular,Menlo,monospace}.version-section{margin-top:48px}.version-section>p,.empty{color:#607166;font-size:14px;line-height:1.6}.version-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:18px}.version-item{background:#fff;border:1px solid #dee7da;border-radius:12px;padding:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}.version-item strong{min-width:62px;font-size:13px}.version-item code{flex:1;min-width:190px;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#30523c;overflow-wrap:anywhere}.version-item .btn{white-space:nowrap}
.console{margin-top:46px;border:1px solid #d8e4d7;border-radius:16px;overflow:hidden;background:#fff}.console-head{padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid #e3eae0}.console-head strong{font-size:15px}.console-head span{font-size:12px;color:#678171}.console pre{min-height:144px;max-height:340px;overflow:auto;margin:0;padding:20px;background:#f9fbf7;font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;color:#21452e;white-space:pre-wrap;overflow-wrap:anywhere}.console .status{font-size:13px;color:#536c59;margin:0;padding:11px 20px;border-top:1px solid #e4eae1}.status.error{color:#b53b2d}.aside{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:42px}.explain{border:1px solid #dde6d8;background:#eef3e9;border-radius:14px;padding:20px}.explain h3{font-size:16px;margin:0 0 10px}.explain p{font-size:13px;line-height:1.6;color:#52675a;margin:0}.explain code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.ref{margin-top:34px;color:#627769;font-size:13px}.ref a{color:#19633b}
@media(max-width:800px){.flow,.cards,.aside,.version-list{grid-template-columns:1fr}main{padding-top:32px!important}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
</style>
</head>
<body>
<header class="mast"><div class="wrap"><div class="brand"><i aria-hidden="true"></i> Worker version routing</div><small>Interactive Cloudflare Workers reference</small></div></header>
<main class="wrap">
<section class="hero"><div class="eyebrow">A hands-on architecture demo</div><h1>One Worker.<br>Any uploaded version.</h1><p>A caller Worker reaches fixed Version URLs over HTTP, even when those versions are outside the current production deployment. Its <code>global_fetch_strictly_public</code> flag deliberately sends those requests through Cloudflare's public front door.</p></section>
<div class="chips"><span class="chip">2 Workers</span><span class="chip">1 target script</span><span class="chip">${config.labVersions.length} fixed lab versions</span><span class="chip">Live Worker → Worker requests</span></div>
<section class="map" aria-label="Request flow"><h2>Two selectors, two guarantees</h2><div class="flow"><div class="node"><small>Fixed destination</small><strong>Caller → Version URL</strong><p>A unique workers.dev hostname stays pinned to one upload, independent of the production traffic split.</p></div><div class="node"><small>Current deployment</small><strong>Caller → Service binding</strong><p>A version override selects a version in the active deployment, including one allocated 0% traffic.</p></div></div><p class="hint">Every button below calls the caller Worker first. The response panel reports the requested URL and exact target version that executed.</p></section>
<section aria-labelledby="destinations"><div class="section-heading"><h2 id="destinations">Choose a route</h2><span>All routes reach ${escapeHtml(config.worker)}</span></div><div class="cards">
<article class="card"><div class="top"><span class="label">Production</span><span class="dot" aria-hidden="true"></span></div><h3>Live deployment</h3><p>The caller fetches the target's production workers.dev origin through the public edge.</p><code class="address">${escapeHtml(config.targetOrigin)}</code><div class="actions"><button type="button" class="btn" data-query="" data-release="production">Worker fetch →</button><a class="btn secondary" href="${escapeHtml(config.targetOrigin)}/health" target="_blank" rel="noopener noreferrer">Open URL ↗</a></div></article>
${candidateCards}${aliasCard}
</div></section>
<section class="version-section" aria-labelledby="lab-heading"><div class="section-heading"><h2 id="lab-heading">${config.labVersions.length || "Ten"} versions. Fixed URLs.</h2><span>Uploaded without entering production traffic</span></div><p>Each upload runs the same script with a distinct release label. Select one to verify that the caller reaches its exact version ID.</p><div class="version-list">${versionRows || '<p class="empty">Run the bootstrap command to populate this version manifest.</p>'}</div></section>
<form class="picker" id="picker"><label for="version-id">Try another version ID</label><input id="version-id" name="version-id" required pattern="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" aria-describedby="picker-help"><button type="submit" class="btn">Fetch this version →</button></form><p class="ref" id="picker-help">Only versions uploaded to this target Worker with Version URLs enabled can respond.</p>
<section class="console" id="response" aria-live="polite"><div class="console-head"><strong>Live response</strong><span id="source">No request yet</span></div><pre id="output">Choose a request path above to inspect the response.</pre><p class="status" id="status">Ready to explore.</p></section>
<section class="aside"><div class="explain"><h3>Why fixed URLs work</h3><p>The caller opts into <code>global_fetch_strictly_public</code>. Its global <code>fetch()</code> reaches public workers.dev Version URLs through Cloudflare's front door. These URLs use each version's production configuration and remain public unless protected with Access.</p></div><div class="explain"><h3>Why keep the binding</h3><p>The fetch-style service binding is the documented Worker-to-Worker path for <code>Cloudflare-Workers-Version-Overrides</code>. Overrides only select versions in the current deployment; fixed Version URLs are what make older uploads independently callable.</p></div></section>
<p class="ref">Read the <a href="https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public">compatibility flag docs</a>, <a href="https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/">Version URL docs</a>, and <a href="https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/">version override docs</a>.</p>
</main>
<script type="application/json" id="config">${data}</script>
<script>
const config = JSON.parse(document.getElementById('config').textContent);
const source = document.getElementById('source');
const output = document.getElementById('output');
const status = document.getElementById('status');
let current = 0;

async function probe(query, expectedVersion, expectedRelease) {
  const ticket = ++current;
  const url = config.callerOrigin + '/probe' + (query ? '?' + query : '');
  source.textContent = 'Caller Worker → GET ' + url;
  status.className = 'status';
  status.textContent = 'Sending request...';
  output.textContent = 'Waiting for response...';
  try {
    const response = await fetch(url, { cache: 'no-store' });
    const result = await response.json();
    if (ticket !== current) return;
    output.textContent = JSON.stringify(result, null, 2);
    const target = result.upstream?.body;
    const ok = response.ok && result.upstream?.status === 200 && target?.worker === config.worker
      && (!expectedVersion || target.versionId === expectedVersion)
      && (!expectedRelease || target.release === expectedRelease);
    status.textContent = ok
      ? 'Success · ' + target.hostname + ' ran release "' + target.release + '" (version ' + target.versionId + ').'
      : 'The response did not match the expected version. Inspect the payload above.';
    if (!ok) status.classList.add('error');
  } catch (error) {
    if (ticket !== current) return;
    status.className = 'status error';
    status.textContent = 'Request failed. Verify that the caller Worker is deployed and reachable.';
    output.textContent = String(error);
  }
}

document.querySelectorAll('[data-query]').forEach(button => button.addEventListener('click', () => {
  probe(button.dataset.query || '', button.dataset.version, button.dataset.release);
}));
document.getElementById('picker').addEventListener('submit', event => {
  event.preventDefault();
  const version = document.getElementById('version-id').value.trim();
  probe('uploaded=' + encodeURIComponent(version), version);
});
</script>
</body></html>`;
}

/** Escapes deployment-controlled values before inserting them into HTML. */
function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	})[character] ?? character);
}
