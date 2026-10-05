import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { emptyManifest, normalizeManifest, ownedOrigin, parsePreviewOutput, selectOwnedUrl, validateManifest } from "../scripts/manifest.mjs";
import { checkBundles, projectPreviewConfig } from "../scripts/check-previews.mjs";
import { assertNewRevision, cleanupPreview, deployPreviewPair, previewCommand, recoverPreviewReceipt, verifyPreviewHistory } from "../scripts/previews.mjs";
import { PROJECT_ROOT, TARGET_WORKER, CALLER_WORKER, TARGET_CONFIG } from "../scripts/wrangler.mjs";

const fixture = JSON.parse(readFileSync(new URL("../test/preview.fixture.json", import.meta.url), "utf8"));
const account = { id: fixture.accountId };
const own = async (_manifest, worker) => ({ identity: {
	worker, versionId: worker === TARGET_WORKER ? fixture.productionVersionId : fixture.callerVersionId,
} });

function output(resource, deployment) {
	return JSON.stringify({
		preview: resource,
		deployment: { ...deployment, preview_id: resource.id, preview_name: resource.name },
	});
}

test("captures opaque provider IDs and exact URLs independently of the executing version", () => {
	const branch = fixture.previews[0];
	const first = branch.revisions[0].target;
	const result = parsePreviewOutput(output(branch.target, first), TARGET_WORKER, "example", "branch-ui");
	assert.equal(result.resource.slug, "backend-ui-slug");
	assert.equal(result.receipt.id, "deployment-target-one");
	assert.equal(result.receipt.url, first.url);
	assert.equal(result.receipt.versionId, ""); // Only /health can fill this field.
	assert.equal(result.receipt.verified, false);
	assert.equal(parsePreviewOutput(JSON.stringify({ preview: branch.target, deployment: first }), TARGET_WORKER, "example", "branch-ui").receipt.id, first.id);
	assert.equal(selectOwnedUrl(branch.target.urls, TARGET_WORKER, "example"), branch.target.url);
	assert.equal(validateManifest(fixture).previews[0].revisions[0].target.versionId, first.versionId);
});

test("refuses missing URLs, mismatched Preview identities, and non-owned destinations", () => {
	const branch = fixture.previews[0];
	const deployment = branch.revisions[0].target;
	assert.throws(() => parsePreviewOutput(output({ ...branch.target, urls: [] }, deployment), TARGET_WORKER, "example", "branch-ui"), /required Preview URLs/);
	assert.throws(() => parsePreviewOutput(output(branch.target, deployment), TARGET_WORKER, "example", "branch-other"), /unexpected Preview/);
	assert.throws(() => parsePreviewOutput(JSON.stringify({ preview: branch.target, deployment: { ...deployment, preview_id: "another-resource" } }), TARGET_WORKER, "example", "branch-ui"), /unexpected Preview/);
	assert.throws(() => selectOwnedUrl(["https://outside.example"], TARGET_WORKER, "example"), /No target-owned/);
	for (const value of [`${branch.target.url}/path`, `https://user@${new URL(branch.target.url).hostname}`, `${branch.target.url}:444`, `${branch.target.url}.outside.example`]) {
		assert.throws(() => ownedOrigin(value, TARGET_WORKER, "example"));
	}
});

test("upgrades an older ownership record while preserving its existing uploaded versions", () => {
	const old = { accountId: fixture.accountId, workersDevSubdomain: "example", candidateVersionId: fixture.candidateVersionId, labVersions: fixture.labVersions };
	const upgraded = normalizeManifest(old);
	assert.equal(upgraded.schemaVersion, 2);
	assert.deepEqual(upgraded.labVersions, old.labVersions);
	assert.deepEqual(upgraded.previews, []);
	assert.throws(() => normalizeManifest({ ...old, schemaVersion: 99 }), /Unsupported/);
});

test("reserves distinct Preview names and never overwrites a recorded fixed revision", () => {
	assert.throws(() => assertNewRevision(fixture, "candidate", "r1"), /reserved Preview name/);
	assert.throws(() => assertNewRevision(fixture, "branch-ui", "r1"), /already recorded/);
	const partial = structuredClone(fixture);
	partial.previews[0].revisions[0].caller = null;
	assert.equal(assertNewRevision(partial, "branch-ui", "r1").target.id, fixture.previews[0].revisions[0].target.id);
	assert.throws(() => assertNewRevision(fixture, "branch-ui", "r123456789"), /revision key/);
});

test("validates projected Preview bundles without a Preview command or production binding", () => {
	const production = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "workers/caller/wrangler.jsonc"), "utf8"));
	const projected = projectPreviewConfig(production);
	assert.equal(projected.services, undefined);
	assert.equal(projected.vars.ENVIRONMENT, "preview");
	assert.equal(projected.version_metadata.binding, "CF_VERSION_METADATA");
	assert.deepEqual(projected.routes, []);
	const calls = [];
	checkBundles({ production: false, run: (args) => calls.push(args) });
	assert.equal(calls.length, 2);
	for (const args of calls) {
		assert.equal(args[0], "deploy");
		assert.ok(args.includes("--dry-run"));
		assert.equal(existsSync(resolve(PROJECT_ROOT, args.at(-1))), false);
	}
});

test("cleans temporary validation configuration even when bundling fails", () => {
	assert.throws(() => checkBundles({ production: false, run: () => { throw new Error("bundle failed"); } }), /bundle failed/);
	assert.equal(existsSync(resolve(PROJECT_ROOT, "workers/target/wrangler.preview-check.generated.json")), false);
});

test("rejects a CI override that would send both Previews to the same parent", () => {
	const previous = process.env.WRANGLER_CI_OVERRIDE_NAME;
	process.env.WRANGLER_CI_OVERRIDE_NAME = "some-other-worker";
	try { assert.throws(() => previewCommand(TARGET_CONFIG, TARGET_WORKER, "branch-ui", [], "r1"), /overrides both parent/); }
	finally {
		if (previous === undefined) delete process.env.WRANGLER_CI_OVERRIDE_NAME;
		else process.env.WRANGLER_CI_OVERRIDE_NAME = previous;
	}
});

for (const { failedWorker, changedProduction } of [
	{ failedWorker: TARGET_WORKER }, { failedWorker: CALLER_WORKER },
	{ failedWorker: "paired-proof" }, { failedWorker: "paired-proof", changedProduction: true },
]) test(`resumes pending ${failedWorker} verification without redeploying${changedProduction ? " and rejects a changed production baseline" : " either fixed deployment"}`, async () => {
	let state = { ...emptyManifest(), accountId: fixture.accountId, workersDevSubdomain: "example" };
	const targetResource = { ...fixture.previews[0].target, name: "branch-test", slug: "branch-test", url: "https://branch-test-worker-version-routing-target.example.workers.dev", urls: ["https://branch-test-worker-version-routing-target.example.workers.dev"] };
	const callerResource = { ...fixture.previews[0].caller, name: "branch-test", slug: "branch-test", url: "https://branch-test-worker-version-routing-caller.example.workers.dev", urls: ["https://branch-test-worker-version-routing-caller.example.workers.dev"] };
	const target = fixture.previews[0].revisions[0].target;
	const caller = fixture.previews[0].revisions[0].caller;
	const calls = [];
	const remote = new Map();
	let productionVersion = fixture.productionVersionId;
	const run = (args) => {
		calls.push(args);
		const worker = args.includes(TARGET_WORKER) ? TARGET_WORKER : CALLER_WORKER;
		const resource = worker === TARGET_WORKER ? targetResource : callerResource;
		remote.set(worker, resource);
		return output(resource, worker === TARGET_WORKER ? target : caller);
	};
	let interrupted = true;
	const verify = async (url, predicate) => {
		if (interrupted && (failedWorker === "paired-proof" ? url.includes("/probe") : url.startsWith(failedWorker === TARGET_WORKER ? target.url : caller.url))) throw new Error("verification interrupted");
		let body;
		if (url.includes("/probe")) body = { caller: { versionId: caller.versionId }, upstream: { body: { versionId: target.versionId } }, matchesExpectedVersion: true };
		else if (url.startsWith(target.url)) body = { worker: TARGET_WORKER, environment: "preview", previewKey: "branch-test", release: "branch-test-r1", responseVariant: "compact", versionId: target.versionId, versionTimestamp: target.timestamp };
		else if (url.startsWith(caller.url)) body = { worker: CALLER_WORKER, environment: "preview", previewKey: "branch-test", release: "branch-test-r1", versionId: caller.versionId, versionTimestamp: caller.timestamp };
		else body = { worker: TARGET_WORKER, versionId: productionVersion };
		assert.ok(predicate(body), `Fixture failed predicate for ${url}`);
		return body;
	};
	const options = { name: "branch-test", revision: "r1", variant: "compact", account, run, verify,
		own: async (_manifest, worker) => ({ identity: { worker, versionId: worker === TARGET_WORKER ? productionVersion : fixture.callerVersionId } }),
		lookup: async (_account, worker) => remote.get(worker) ?? null,
		load: () => structuredClone(state), save: (value) => { state = structuredClone(validateManifest(value)); },
	};
	await assert.rejects(deployPreviewPair(options), /interrupted/);
	const pending = state.previews[0].revisions[0];
	assert.equal(pending.target.id, target.id);
	if (failedWorker === TARGET_WORKER) {
		assert.equal(pending.target.verified, false);
		assert.equal(pending.caller, null);
	} else {
		assert.equal(pending.target.versionId, target.versionId);
		assert.equal(pending.caller.id, caller.id);
		assert.equal(pending.caller.verified, false);
		assert.ok(state.previews[0].caller);
	}
	interrupted = false;
	if (changedProduction) {
		productionVersion = fixture.candidateVersionId;
		await assert.rejects(deployPreviewPair(options), /Fixture failed predicate/);
		assert.equal(state.previews[0].revisions[0].caller.verified, false);
	} else {
		await deployPreviewPair(options);
		assert.equal(state.previews[0].revisions[0].caller.verified, true);
	}
	assert.equal(calls.filter((args) => args.includes(TARGET_WORKER)).length, 1);
	assert.equal(calls.filter((args) => args.includes(CALLER_WORKER)).length, 1);
	assert.equal(state.previews[0].revisions[0].target.url, target.url);
	assert.equal(state.previews[0].revisions[0].caller.versionId, caller.versionId);
});

test("refuses unrecorded or replaced resources before mutating either Preview", async () => {
	for (const worker of [TARGET_WORKER, CALLER_WORKER]) {
		const resource = fixture.previews[0][worker === TARGET_WORKER ? "target" : "caller"];
		const empty = { ...emptyManifest(), accountId: fixture.accountId, workersDevSubdomain: "example" };
		const options = { name: "branch-ui", revision: "r3", account, own,
			run: () => assert.fail("must not deploy"), save: () => assert.fail("must not save"),
			lookup: async (_account, parent) => parent === worker ? resource : null,
			load: () => structuredClone(empty),
		};
		await assert.rejects(deployPreviewPair(options), /without a local receipt/);
		await assert.rejects(deployPreviewPair({ ...options, load: () => structuredClone(fixture),
			lookup: async (_account, parent) => ({ ...fixture.previews[0][parent === TARGET_WORKER ? "target" : "caller"], ...(parent === worker ? { id: "replacement-resource" } : {}) }),
		}), /recorded resource identity/);
	}
	await assert.rejects(deployPreviewPair({ name: "branch-new", revision: "r1", account, own,
		load: () => structuredClone(fixture), lookup: async () => { throw new Error("lookup unavailable"); },
		run: () => assert.fail("lookup errors must not authorize a deployment"),
	}), /lookup unavailable/);
});

test("explicit recovery checks API configuration and preserves fixed history", async () => {
	const branch = fixture.previews[0];
	const target = branch.revisions[0].target;
	const raw = { ...target, env: Object.fromEntries(Object.entries({ PREVIEW_KEY: "branch-ui", RELEASE: "branch-ui-r1", ENVIRONMENT: "preview", RESPONSE_VARIANT: "compact" }).map(([key, text]) => [key, { text, type: "plain_text" }])) };
	let saved;
	const options = { name: "branch-ui", revision: "r1", variant: "compact", account, own,
		targetPreviewId: branch.target.id, targetDeploymentId: target.id,
		load: () => ({ ...emptyManifest(), accountId: account.id, workersDevSubdomain: "example" }),
		lookup: async () => branch.target, deployment: async () => raw, save: (value) => { saved = validateManifest(value); },
	};
	await recoverPreviewReceipt(options);
	assert.equal(saved.previews[0].revisions[0].target.id, target.id);
	assert.equal(saved.previews[0].revisions[0].target.versionId, "");
	assert.equal(saved.previews[0].revisions[0].target.verified, false);
	await assert.rejects(recoverPreviewReceipt({ ...options, targetPreviewId: "wrong-resource", save: () => assert.fail("must not save") }), /explicitly supplied/);
	await assert.rejects(recoverPreviewReceipt({ ...options, variant: "detailed", save: () => assert.fail("must not save") }), /different branch configuration/);
	await assert.rejects(recoverPreviewReceipt({ ...options,
		load: () => saved, targetDeploymentId: "another-fixed-deployment", deployment: async () => ({ ...raw, id: "another-fixed-deployment" }),
		save: () => assert.fail("must not replace fixed history"),
	}), /cannot replace a recorded fixed deployment/);
});

test("cleanup reconciles resource IDs before deleting caller then target", async () => {
	const calls = [];
	let saved;
	const remote = new Map([[TARGET_WORKER, fixture.previews[0].target], [CALLER_WORKER, fixture.previews[0].caller]]);
	await cleanupPreview("branch-ui", {
		account, own, load: () => structuredClone(fixture), save: (value) => { saved = value; },
		lookup: async (_account, worker) => remote.get(worker) ?? null,
		run: (args) => {
			calls.push(args);
			remote.delete(args[args.indexOf("--worker-name") + 1]);
		},
	});
	assert.deepEqual(calls.map((args) => args[args.indexOf("--worker-name") + 1]), [CALLER_WORKER, TARGET_WORKER]);
	assert.equal(saved.previews.length, 0);
	await assert.rejects(cleanupPreview("branch-missing", { account, load: () => structuredClone(fixture), run: () => assert.fail("must not delete") }), /absent/);
	await assert.rejects(cleanupPreview("branch-ui", { account, own, load: () => structuredClone(fixture),
		lookup: async (_account, worker) => ({ ...fixture.previews[0][worker === TARGET_WORKER ? "target" : "caller"], id: "replacement-resource" }),
		run: () => assert.fail("must not delete"),
	}), /recorded resource identity/);
});

test("history verification checks branch configuration and preserves production evidence", async () => {
	const state = structuredClone(fixture);
	const production = { name: "production: unchanged by Preview deployments", passed: true, at: "2026-10-05T00:00:00.000Z", targetVersionId: fixture.productionVersionId };
	state.checks.push(production);
	let saved;
	await verifyPreviewHistory({ account, load: () => state, save: (value) => { saved = value; }, verify: async (url, predicate) => {
		const branch = state.previews[0];
		const latest = branch.revisions.at(-1);
		const revision = branch.revisions.find((entry) => url.startsWith(entry.target.url) || url.startsWith(entry.caller.url)) ?? latest;
		const body = url.includes("/probe")
			? { caller: { versionId: revision.caller.versionId }, upstream: { body: { versionId: url.includes("pinned") ? revision.target.versionId : latest.target.versionId } }, matchesExpectedVersion: true }
			: { versionId: revision.target.versionId, environment: "preview", previewKey: branch.key, release: revision.release, responseVariant: revision.variant };
		assert.ok(predicate(body));
		return body;
	} });
	assert.ok(saved.checks.includes(production));
	assert.ok(saved.checks.some((entry) => entry.name === "branch-ui-r1: both hops pinned"));
});

test("resumes target cleanup after caller deletion without losing its ownership receipt", async () => {
	let state = structuredClone(fixture);
	const remote = new Map([[TARGET_WORKER, state.previews[0].target], [CALLER_WORKER, state.previews[0].caller]]);
	const calls = [];
	let failTarget = true;
	const options = { account, own, load: () => structuredClone(state), save: (value) => { state = structuredClone(value); },
		lookup: async (_account, worker) => remote.get(worker) ?? null,
		run: (args) => {
			const worker = args[args.indexOf("--worker-name") + 1];
			if (worker === TARGET_WORKER && failTarget) throw new Error("target deletion interrupted");
			calls.push(worker); remote.delete(worker);
		},
	};
	await assert.rejects(cleanupPreview("branch-ui", options), /interrupted/);
	assert.deepEqual(state.previews[0].deletion, { caller: true, target: false });
	assert.ok(state.previews[0].caller);
	failTarget = false;
	await cleanupPreview("branch-ui", options);
	assert.deepEqual(calls, [CALLER_WORKER, TARGET_WORKER]);
	assert.equal(state.previews.length, 0);
});
