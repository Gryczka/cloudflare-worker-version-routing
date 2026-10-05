import assert from "node:assert/strict";
import test from "node:test";
import { emptyManifest } from "../scripts/manifest.mjs";
import { assertOwnedWorker } from "../scripts/ownership.mjs";
import { TARGET_WORKER } from "../scripts/wrangler.mjs";

const active = "11111111-1111-4111-8111-111111111111";
const marker = "22222222-2222-4222-8222-222222222222";
const manifest = { ...emptyManifest(), accountId: "a".repeat(32), workersDevSubdomain: "example" };
function lookups(identity) {
	return {
		subdomain: async () => "example",
		get: async () => ({ deployments: [{ versions: [{ version_id: active, percentage: 100 }] }] }),
		verify: async (_url, predicate) => {
			if (!predicate(identity)) throw new Error("ownership identity mismatch");
			return identity;
		},
	};
}

test("account-only intent cannot authorize an existing same-name Worker", async () => {
	await assert.rejects(assertOwnedWorker(manifest, TARGET_WORKER, lookups({ worker: TARGET_WORKER, versionId: active })), /ownership identity/);
});

test("upgrades only a recorded still-active legacy version", async () => {
	const recorded = { ...manifest, productionVersionId: active };
	const result = await assertOwnedWorker(recorded, TARGET_WORKER, lookups({ worker: TARGET_WORKER, versionId: active }));
	assert.equal(result.identity.versionId, active);
	await assert.rejects(assertOwnedWorker(recorded, TARGET_WORKER, lookups({ worker: TARGET_WORKER, versionId: marker })), /ownership identity/);
	await assert.rejects(assertOwnedWorker(recorded, TARGET_WORKER, lookups({ worker: TARGET_WORKER, versionId: active, labId: marker })), /ownership identity/);
});

test("a matching lab marker must also match the Worker and active deployment", async () => {
	const marked = { ...manifest, labId: marker };
	assert.equal((await assertOwnedWorker(marked, TARGET_WORKER, lookups({ worker: TARGET_WORKER, versionId: active, labId: marker }))).identity.labId, marker);
	for (const identity of [
		{ worker: "different-worker", versionId: active, labId: marker },
		{ worker: TARGET_WORKER, versionId: marker, labId: marker },
		{ worker: TARGET_WORKER, versionId: active, labId: active },
	]) await assert.rejects(assertOwnedWorker(marked, TARGET_WORKER, lookups(identity)), /ownership identity/);
});

test("lookup errors and subdomain mismatches fail closed", async () => {
	const options = lookups({ worker: TARGET_WORKER, versionId: active });
	await assert.rejects(assertOwnedWorker(manifest, TARGET_WORKER, { ...options, subdomain: async () => "different" }), /subdomain differs/);
	await assert.rejects(assertOwnedWorker(manifest, TARGET_WORKER, { ...options, get: async () => { throw new Error("API unavailable"); } }), /API unavailable/);
});
