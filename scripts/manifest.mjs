/** Validation shared by install, deployment, and recovery; importing this module has no side effects. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESOURCE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const PREVIEW_KEY = /^branch-[a-z0-9][a-z0-9-]{0,23}$/;
export const REVISION = /^[a-z0-9][a-z0-9-]{0,7}$/;

export function emptyManifest() {
	return {
		schemaVersion: 2, accountId: "", labId: "", workersDevSubdomain: "", uiOrigins: [],
		candidateVersionId: "", productionVersionId: "", callerVersionId: "",
		labVersions: [], previews: [], checks: [],
	};
}

/** Upgrade the original local ownership record without losing uploaded versions. */
export function normalizeManifest(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid local deployment manifest.");
	if (value.schemaVersion !== undefined && ![1, 2].includes(value.schemaVersion)) throw new Error("Unsupported deployment manifest schema.");
	return { ...emptyManifest(), ...value, schemaVersion: 2 };
}

export function origin(value) {
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
		throw new Error("Expected a credential-free HTTPS root origin.");
	}
	return url.origin;
}

export function ownedOrigin(value, worker, subdomain) {
	const normalized = origin(value);
	const hostname = new URL(normalized).hostname;
	const suffix = `${worker}.${subdomain}.workers.dev`;
	const prefix = hostname.endsWith(`-${suffix}`) ? hostname.slice(0, -(suffix.length + 1)) : "";
	if (!(hostname === suffix || /^[a-z0-9][a-z0-9-]{0,62}$/.test(prefix)) || hostname.split(".").some((label) => label.length > 63)) {
		throw new Error(`URL does not belong to ${worker} on the recorded workers.dev subdomain.`);
	}
	return normalized;
}

/** Select a workers.dev URL even when a provider returns a custom domain first. */
export function selectOwnedUrl(urls, worker, subdomain) {
	if (!Array.isArray(urls) || urls.length === 0 || urls.some((url) => typeof url !== "string")) {
		throw new Error("Wrangler did not return the required Preview URLs.");
	}
	for (const value of urls) {
		try { return ownedOrigin(value, worker, subdomain); } catch { /* Other enabled hostnames are not the HTTP routing destination. */ }
	}
	throw new Error(`No target-owned workers.dev URL was returned for ${worker}.`);
}

export function validateManifest(raw, { allowEmpty = false } = {}) {
	const manifest = normalizeManifest(raw);
	if (!(allowEmpty && !manifest.accountId) && !/^[0-9a-f]{32}$/.test(manifest.accountId)) throw new Error("Invalid manifest account ID.");
	if (manifest.workersDevSubdomain && !SUBDOMAIN.test(manifest.workersDevSubdomain)) throw new Error("Invalid workers.dev subdomain.");
	if (manifest.labId && !UUID.test(manifest.labId)) throw new Error("Invalid lab ownership marker.");
	for (const field of ["candidateVersionId", "productionVersionId", "callerVersionId"]) {
		if (manifest[field] && !UUID.test(manifest[field])) throw new Error(`Invalid ${field}.`);
	}
	if (!Array.isArray(manifest.labVersions) || manifest.labVersions.some(({ id, release }) => !UUID.test(id) || !/^lab-\d{2}$/.test(release))) throw new Error("Invalid lab versions.");
	if (!manifest.candidateVersionId && manifest.labVersions.length) throw new Error("Refusing lab versions without a candidate version.");
	if (!Array.isArray(manifest.uiOrigins) || manifest.uiOrigins.some((value) => origin(value) !== value)) throw new Error("Invalid showcase origins.");
	if (!Array.isArray(manifest.previews) || !Array.isArray(manifest.checks)) throw new Error("Invalid Preview history or checks.");
	const keys = new Set();
	for (const branch of manifest.previews) {
		if (!PREVIEW_KEY.test(branch.key) || keys.has(branch.key) || !Array.isArray(branch.revisions)) throw new Error("Invalid or duplicate Preview key.");
		keys.add(branch.key);
		validateResource(branch.target, "worker-version-routing-target", manifest.workersDevSubdomain);
		if (branch.caller) validateResource(branch.caller, "worker-version-routing-caller", manifest.workersDevSubdomain);
		for (const revision of branch.revisions) {
			if (!revision.key.startsWith(`${branch.key}-`) || !/^[a-z][a-z0-9-]{0,39}$/.test(revision.key) || keys.has(revision.key)) throw new Error("Invalid or duplicate revision key.");
			keys.add(revision.key);
			if (typeof revision.release !== "string" || !revision.release || !["compact", "detailed"].includes(revision.variant)) throw new Error("Invalid Preview revision configuration.");
			if (revision.productionBeforeVersionId !== undefined && !UUID.test(revision.productionBeforeVersionId)) throw new Error("Invalid recorded production baseline.");
			validateDeployment(revision.target, "worker-version-routing-target", manifest.workersDevSubdomain);
			if (revision.caller) validateDeployment(revision.caller, "worker-version-routing-caller", manifest.workersDevSubdomain);
		}
	}
	return manifest;
}

function validateResource(resource, worker, subdomain) {
	if (!resource || !RESOURCE_ID.test(resource.id) || typeof resource.name !== "string" || !resource.name || typeof resource.slug !== "string" || !resource.slug) throw new Error("Invalid Preview resource receipt.");
	if (selectOwnedUrl(resource.urls, worker, subdomain) !== resource.url) throw new Error("Preview origin does not match the provider URLs.");
}

function validateDeployment(deployment, worker, subdomain) {
	if (!deployment || !RESOURCE_ID.test(deployment.id) || typeof deployment.release !== "string") throw new Error("Invalid Preview deployment receipt.");
	if (deployment.verified !== false && (!UUID.test(deployment.versionId) || !deployment.timestamp)) throw new Error("Unverified deployment needs an explicit pending-verification state.");
	if (deployment.verified === false && deployment.versionId && !UUID.test(deployment.versionId)) throw new Error("Invalid pending version ID.");
	if (selectOwnedUrl(deployment.urls, worker, subdomain) !== deployment.url) throw new Error("Fixed deployment origin does not match the provider URLs.");
}

/** Parse the real nested JSON contract; the format version is not an executing version ID. */
export function parsePreviewOutput(output, worker, subdomain, requestedName) {
	const { preview, deployment } = JSON.parse(output);
	if (!preview || !deployment || !RESOURCE_ID.test(preview.id) || !RESOURCE_ID.test(deployment.id) ||
		preview.name !== requestedName || typeof preview.slug !== "string" || !preview.slug ||
		(deployment.preview_id !== undefined && deployment.preview_id !== preview.id) ||
		(deployment.preview_name !== undefined && deployment.preview_name !== preview.name)) {
		throw new Error("Wrangler returned an unexpected Preview/deployment identity.");
	}
	const resource = {
		id: preview.id, name: preview.name, slug: preview.slug,
		url: selectOwnedUrl(preview.urls, worker, subdomain), urls: preview.urls,
	};
	const receipt = {
		id: deployment.id, url: selectOwnedUrl(deployment.urls, worker, subdomain), urls: deployment.urls,
		versionId: "", release: "", timestamp: "", verified: false,
	};
	if (receipt.url === resource.url) throw new Error("Fixed and stable Preview URLs must be distinct.");
	return { resource, receipt };
}
