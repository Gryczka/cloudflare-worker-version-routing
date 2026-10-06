/** Readable routing figures: labels come from verified receipts, execution proof comes from requests. */
import type { PreviewBranch, PreviewRevision } from "../../shared/catalog";

export function renderBranchDiagram(branch?: PreviewBranch): string {
	const first = branch?.revisions[0];
	const latest = branch?.revisions.at(-1);
	const earlierRelease = first?.release ?? "branch-ui-r1";
	const latestRelease = latest?.release ?? "branch-ui-r2";
	const caption = first && latest
		? first === latest
			? "One deployment is recorded so far. The stable and fixed URLs currently reach the same revision; advance the Preview to create replayable history."
			: `Recorded history: ${earlierRelease} → ${latestRelease}. The branch URL advances; the original fixed URL still replays the earlier deployment. Verify execution with the buttons below.`
		: "Illustrative routing after r1 → r2. Bootstrap the lab to capture real URLs and executing version IDs. Production is a separate deployment.";
	return `<figure class="route-diagram branch-map" aria-labelledby="branch-map-title" aria-describedby="branch-map-caption">
<div class="diagram-heading"><div><span class="diagram-kicker">${branch ? `Recorded Preview · ${html(branch.key)}` : "Illustrative Preview · r1 → r2"}</span><h2 id="branch-map-title">The branch moves. The fixed URL stays put.</h2></div><span class="diagram-production">Production is separate</span></div>
<div class="branch-map-grid">
<div class="diagram-flow" role="group" aria-label="Stable branch URL follows the latest deployment">
${node("Moving pointer", "Stable branch URL", branch?.key ?? "branch-ui", "moving")}${arrow("moving")}${node("Latest deployment", latestRelease, latest ? version(latest.target.versionId) : "Target r2", "latest")}
</div>
<div class="diagram-flow" role="group" aria-label="Original fixed URL replays the earlier deployment">
${node("Captured pointer", "Original fixed URL", "Saved at the first deployment", "fixed")}${arrow("fixed")}${node("Retained deployment", earlierRelease, first ? version(first.target.versionId) : "Target r1", "fixed")}
</div>
</div>
<figcaption class="diagram-caption" id="branch-map-caption">${html(caption)}</figcaption>
<div class="diagram-legend" aria-label="Connector legend"><span><i class="line-swatch moving" aria-hidden="true"></i>Dashed: follows latest</span><span><i class="line-swatch fixed" aria-hidden="true"></i>Solid: captured deployment</span></div>
</figure>`;
}

export function renderPinningDiagram(branch: PreviewBranch, first: PreviewRevision, latest: PreviewRevision, pinned: boolean): string {
	if (!first.caller) return "";
	const target = pinned ? first : latest;
	const id = pinned ? "pinned-path-caption" : "moving-path-caption";
	return `<figure class="route-diagram pair-diagram" aria-labelledby="${id}">
<div class="diagram-flow three-hop">
${node("Fixed caller", first.caller.release, version(first.caller.versionId), "fixed")}${arrow("fixed")}${node(pinned ? "Captured target URL" : "Moving target URL", pinned ? "Fixed deployment" : "Stable branch", pinned ? first.release : branch.key, pinned ? "fixed" : "moving")}${arrow(pinned ? "fixed" : "moving")}${node("Expected target", target.release, version(target.target.versionId), pinned ? "fixed" : "latest")}
</div>
<figcaption class="diagram-caption" id="${id}">Recorded expectation · public HTTP at every hop. ${pinned ? "Same caller, same original target." : "Same caller, latest branch target."} Short version IDs are shown; the response below proves the full execution identities.</figcaption>
</figure>`;
}

export function renderVersionRoutingDiagram(candidate: string): string {
	return `<figure class="route-diagram version-map" aria-labelledby="version-map-title" aria-describedby="version-map-caption">
<div class="diagram-heading"><div><span class="diagram-kicker">Production caller · three routes</span><h3 id="version-map-title">An upload address and a version override take different paths.</h3></div></div>
<div class="version-map-route"><span class="diagram-route-label">01 · Default traffic</span><div class="diagram-flow three-hop">
${node("Caller Worker", "Normal request", "No version selector", "neutral")}${arrow("neutral")}${node("Public HTTP", "Production URL", "Normal deployment routing", "neutral")}${arrow("neutral")}${node("Active deployment", "Production version", "100% default traffic", "latest")}
</div></div>
<div class="version-map-route"><span class="diagram-route-label">02 · Address an upload</span><div class="diagram-flow three-hop">
${node("Caller Worker", "Upload / alias request", "Select an uploaded version", "neutral")}${arrow("neutral")}${node("Public HTTP", "Version URL / alias", "Upload's production configuration", "moving")}${arrow("neutral")}${node("Addressed upload", "Uploaded version", candidate ? `Candidate example · ${candidate.slice(0, 8)}` : "For example, the candidate", "fixed")}
</div></div>
<div class="version-map-route"><span class="diagram-route-label">03 · Select the 0% candidate</span><div class="diagram-flow three-hop">
${node("Caller Worker", "Version override", "Select the candidate's UUID", "neutral")}${arrow("fixed")}${node("Service binding", "fetch() + override header", "Cloudflare-Workers-Version-Overrides", "fixed")}${arrow("fixed")}${node("Active deployment", "Candidate version", "0% default traffic · explicitly selected", "fixed")}
</div></div>
<figcaption class="diagram-caption" id="version-map-caption">Version URLs can reach uploads outside the active deployment. The override requires a version in that deployment; 0% describes its default traffic allocation, not its availability to an explicit override.</figcaption>
</figure>`;
}

function node(role: string, title: string, detail: string, tone: "moving" | "fixed" | "latest" | "neutral"): string {
	return `<div class="diagram-node ${tone}"><span class="diagram-role">${html(role)}</span><strong>${html(title)}</strong><span class="diagram-detail">${html(detail)}</span></div>`;
}

function version(id: string): string {
	return `Version · ${id.slice(0, 8)}`;
}

function arrow(tone: "moving" | "fixed" | "neutral"): string {
	return `<span class="diagram-edge ${tone}" aria-hidden="true"><svg viewBox="0 0 40 20" focusable="false"><path class="edge-line" d="M1 10H35"/><path d="m28 3 7 7-7 7"/></svg></span>`;
}

function html(value: string): string {
	return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}
