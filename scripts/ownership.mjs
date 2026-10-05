/** An account-only deployment intent cannot authorize overwriting an existing Worker. */
import { accountGet, accountSubdomain } from "./cloudflare-api.mjs";
import { CALLER_WORKER, TARGET_WORKER, getOrigins, verifyEndpoint } from "./wrangler.mjs";

export async function assertOwnedWorker(manifest, worker, { get = accountGet, subdomain = accountSubdomain, verify = verifyEndpoint } = {}) {
	const actualSubdomain = await subdomain(manifest.accountId);
	if (manifest.workersDevSubdomain && manifest.workersDevSubdomain !== actualSubdomain) throw new Error("Recorded subdomain differs from the selected account.");
	const deployment = await get(manifest.accountId, `workers/scripts/${worker}/deployments`);
	const serving = deployment?.deployments?.[0]?.versions?.filter((version) => version.percentage > 0) ?? [];
	if (serving.length === 0) throw new Error("Existing Worker has no verified production deployment.");
	const origins = getOrigins(actualSubdomain);
	const expected = worker === TARGET_WORKER ? manifest.productionVersionId : worker === CALLER_WORKER ? manifest.callerVersionId : null;
	if (expected === null) throw new Error("Unknown lab Worker.");
	const url = `${worker === TARGET_WORKER ? origins.targetOrigin : origins.callerOrigin}/health`;
	const identity = await verify(url, (body) => {
		if (body.worker !== worker || !serving.some((version) => version.version_id === body.versionId)) return false;
		if (manifest.labId && body.labId === manifest.labId) return true;
		// A prior reference release can be upgraded only from its recorded, still-active version.
		return !body.labId && Boolean(expected) && body.versionId === expected;
	}, "lab ownership (marker or recorded legacy version)");
	return { identity, subdomain: actualSubdomain };
}

export function assertPreviewOwnership(remote, recorded, name) {
	if (!recorded) {
		if (remote) throw new Error(`Preview ${name} already exists without a local receipt. Verify and explicitly recover its resource/deployment IDs before adopting it.`);
		return;
	}
	if (!remote || remote.id !== recorded.id || remote.name !== recorded.name || remote.slug !== recorded.slug) throw new Error(`Preview ${name} no longer matches its recorded resource identity. Refusing to change it.`);
}
