/** Paired Preview lifecycle, with pre-mutation identity checks and resumable receipts. */
import { PREVIEW_KEY, REVISION, parsePreviewOutput } from "./manifest.mjs";
import { getNamedPreview, getPreviewDeployment } from "./cloudflare-api.mjs";
import { assertOwnedWorker, assertPreviewOwnership } from "./ownership.mjs";
import {
	TARGET_CONFIG, CALLER_CONFIG, TARGET_WORKER, CALLER_WORKER,
	assertAccountSelected, assertManifestOwner, callerVarArgs, targetVarArgs,
	getOrigins, readManifest, runWrangler, verifyEndpoint, writeManifest,
} from "./wrangler.mjs";

export function previewCommand(config, worker, name, vars, release) {
	if (process.env.WRANGLER_CI_OVERRIDE_NAME) throw new Error("Unset WRANGLER_CI_OVERRIDE_NAME before deploying a paired Preview; it overrides both parent Worker names.");
	return ["preview", "--config", config, "--worker-name", worker, "--name", name,
		"--tag", release, "--message", `Paired Preview ${release}`, ...vars, "--json"];
}

export function assertNewRevision(manifest, name, revision) {
	if (!PREVIEW_KEY.test(name)) throw new Error("Use a short reserved Preview name: branch- followed by at most 24 lowercase letters, digits, or dashes.");
	if (!REVISION.test(revision)) throw new Error("Use a short revision key of at most eight lowercase letters, digits, or dashes.");
	const branch = manifest.previews.find((entry) => entry.key === name);
	if (branch?.deletion) throw new Error("Finish pending Preview cleanup before using this name again.");
	const existing = branch?.revisions.find((entry) => entry.key === `${name}-${revision}`);
	if (existing?.caller && existing.caller.verified !== false) throw new Error("This revision is already recorded. Choose a new revision key; fixed deployment history is never overwritten.");
	return existing;
}

async function checkParents(manifest, own) {
	const target = await own(manifest, TARGET_WORKER);
	await own(manifest, CALLER_WORKER);
	return target.identity;
}

async function checkPreviewPair(manifest, branch, name, lookup) {
	// Check both names before changing either Worker. Lookup failures are not absence.
	const target = await lookup(manifest.accountId, TARGET_WORKER, branch?.target.slug ?? name);
	const caller = await lookup(manifest.accountId, CALLER_WORKER, branch?.caller?.slug ?? name);
	assertPreviewOwnership(target, branch?.target, name);
	assertPreviewOwnership(caller, branch?.caller, name);
}

export async function deployPreviewPair({ name, revision, variant = "compact", account = assertAccountSelected(),
	run = runWrangler, verify = verifyEndpoint, load = readManifest, save = writeManifest,
	lookup = getNamedPreview, own = assertOwnedWorker,
}) {
	if (process.env.WRANGLER_CI_OVERRIDE_NAME) throw new Error("Unset WRANGLER_CI_OVERRIDE_NAME before paired Preview work.");
	if (!["compact", "detailed"].includes(variant)) throw new Error("Choose compact or detailed Preview configuration.");
	const manifest = load();
	const subdomain = assertManifestOwner(manifest, account.id);
	let entry = assertNewRevision(manifest, name, revision);
	const release = `${name}-${revision}`;
	let branch = manifest.previews.find((item) => item.key === name);
	const before = await checkParents(manifest, own);
	await checkPreviewPair(manifest, branch, name, lookup);
	if (entry && entry.variant !== variant) throw new Error("An interrupted revision must resume with its recorded configuration.");

	if (!entry) {
		const output = run(previewCommand(TARGET_CONFIG, TARGET_WORKER, name,
			targetVarArgs(release, subdomain, { LAB_ID: manifest.labId, ENVIRONMENT: "preview", PREVIEW_KEY: name, RESPONSE_VARIANT: variant }), release), { print: false });
		const { resource, receipt } = parsePreviewOutput(output, TARGET_WORKER, subdomain, name);
		if (branch && branch.target.id !== resource.id) throw new Error("Preview changed concurrently during deployment. Inspect the returned receipt.");
		receipt.release = release;
		if (!branch) { branch = { key: name, target: resource, caller: null, revisions: [] }; manifest.previews.push(branch); }
		else branch.target = resource;
		entry = { key: release, release, variant, productionBeforeVersionId: before.versionId, target: receipt, caller: null };
		branch.revisions.push(entry);
		save(manifest); // Save provider IDs/URLs BEFORE attempting the first public request.
	}
	if (entry.target.verified === false) {
		const identity = await verify(`${entry.target.url}/health`,
			(body) => body.worker === TARGET_WORKER && body.environment === "preview" && body.previewKey === name && body.release === release && body.responseVariant === variant,
			"pending fixed target Preview deployment");
		Object.assign(entry.target, { versionId: identity.versionId, timestamp: identity.versionTimestamp, verified: true });
		save(manifest);
	} else await verify(`${entry.target.url}/health`, (body) => body.versionId === entry.target.versionId, "recorded fixed target for recovery");

	if (!entry.caller) {
		// Recheck caller just before its own mutation, after target propagation/verification.
		const remote = await lookup(manifest.accountId, CALLER_WORKER, branch.caller?.slug ?? name);
		assertPreviewOwnership(remote, branch.caller, name);
		const output = run(previewCommand(CALLER_CONFIG, CALLER_WORKER, name,
			callerVarArgs(subdomain, manifest, {
				ENVIRONMENT: "preview", PREVIEW_KEY: name, RELEASE: release,
				TARGET_ORIGIN: branch.target.url, PINNED_TARGET_ORIGIN: entry.target.url,
				PINNED_TARGET_VERSION_ID: entry.target.versionId,
			}), release), { print: false });
		const { resource, receipt } = parsePreviewOutput(output, CALLER_WORKER, subdomain, name);
		if (branch.caller && branch.caller.id !== resource.id) throw new Error("Caller Preview changed concurrently during deployment. Inspect the returned receipt.");
		branch.caller = resource;
		receipt.release = release;
		entry.caller = receipt;
		save(manifest);
	}
	if (entry.caller.verified === false) {
		const identity = await verify(`${entry.caller.url}/health`,
			(body) => body.worker === CALLER_WORKER && body.environment === "preview" && body.previewKey === name && body.release === release && (!entry.caller.versionId || body.versionId === entry.caller.versionId),
			"pending fixed caller Preview deployment");
		Object.assign(entry.caller, { versionId: identity.versionId, timestamp: identity.versionTimestamp });
		save(manifest);
	}
	await verify(`${entry.caller.url}/probe?deployment=pinned`,
		(body) => body.caller?.versionId === entry.caller.versionId && body.upstream?.body?.versionId === entry.target.versionId && body.matchesExpectedVersion === true,
		"both-hop pinned Preview request");
	await verify(`${getOrigins(subdomain).targetOrigin}/health`, (body) => body.versionId === (entry.productionBeforeVersionId ?? before.versionId), "production unchanged by Preview deployment");
	entry.caller.verified = true;
	save(manifest); // Pair completion includes pinned routing and the original production baseline.
	console.log(`Preview pair ${release}: ${branch.target.url}\nFixed caller: ${entry.caller.url}\nFixed target: ${entry.target.url}`);
	return entry;
}

/** Explicit recovery of a known successful deployment whose output was lost by older tooling. */
export async function recoverPreviewReceipt({ name, revision, variant, targetPreviewId, targetDeploymentId,
	callerPreviewId, callerDeploymentId, account = assertAccountSelected(), load = readManifest, save = writeManifest,
	lookup = getNamedPreview, deployment = getPreviewDeployment, own = assertOwnedWorker,
}) {
	const manifest = load();
	const subdomain = assertManifestOwner(manifest, account.id);
	assertNewRevision(manifest, name, revision);
	await checkParents(manifest, own);
	if (!["compact", "detailed"].includes(variant)) throw new Error("Supply the known Preview configuration variant.");
	const resource = await lookup(account.id, TARGET_WORKER, name);
	if (!resource || resource.id !== targetPreviewId) throw new Error("Target Preview does not match the explicitly supplied recovery ID.");
	const raw = await deployment(account.id, TARGET_WORKER, resource.slug, targetDeploymentId);
	const release = `${name}-${revision}`;
	if (raw.env?.PREVIEW_KEY?.text !== name || raw.env?.RELEASE?.text !== release || raw.env?.ENVIRONMENT?.text !== "preview" || raw.env?.RESPONSE_VARIANT?.text !== variant) throw new Error("Recovered deployment has different branch configuration.");
	const parsed = parsePreviewOutput(JSON.stringify({ preview: resource, deployment: raw }), TARGET_WORKER, subdomain, name);
	parsed.receipt.release = release;
	let branch = manifest.previews.find((item) => item.key === name);
	if (branch) assertPreviewOwnership(resource, branch.target, name);
	if (!branch) { branch = { key: name, target: parsed.resource, caller: null, revisions: [] }; manifest.previews.push(branch); }
	let entry = branch.revisions.find((item) => item.key === release);
	if (entry && (entry.target.id !== targetDeploymentId || entry.variant !== variant)) throw new Error("Recovery cannot replace a recorded fixed deployment or its configuration.");
	if (!entry) { entry = { key: release, release, variant, target: parsed.receipt, caller: null }; branch.revisions.push(entry); }
	if (callerPreviewId || callerDeploymentId) {
		if (!callerPreviewId || !callerDeploymentId) throw new Error("Supply both caller resource and deployment IDs for recovery.");
		const caller = await lookup(account.id, CALLER_WORKER, name);
		if (!caller || caller.id !== callerPreviewId) throw new Error("Caller Preview differs from its explicit recovery ID.");
		if (branch.caller) assertPreviewOwnership(caller, branch.caller, name);
		if (entry.caller && entry.caller.id !== callerDeploymentId) throw new Error("Recovery cannot replace a recorded caller deployment.");
		const callerRaw = await deployment(account.id, CALLER_WORKER, caller.slug, callerDeploymentId);
		if (callerRaw.env?.PREVIEW_KEY?.text !== name || callerRaw.env?.RELEASE?.text !== release || callerRaw.env?.ENVIRONMENT?.text !== "preview" ||
			callerRaw.env?.TARGET_ORIGIN?.text !== branch.target.url || callerRaw.env?.PINNED_TARGET_ORIGIN?.text !== entry.target.url) throw new Error("Caller recovery configuration does not match.");
		const captured = parsePreviewOutput(JSON.stringify({ preview: caller, deployment: callerRaw }), CALLER_WORKER, subdomain, name);
		captured.receipt.release = release;
		branch.caller = captured.resource;
		entry.caller ??= captured.receipt;
	}
	save(manifest);
	console.log(`Recorded API-verified pending receipts for ${release}. Resume preview:pair with the same name, revision, and variant.`);
}

export async function verifyPreviewHistory({ account = assertAccountSelected(), verify = verifyEndpoint, load = readManifest, save = writeManifest } = {}) {
	const manifest = load();
	assertManifestOwner(manifest, account.id);
	const checks = [];
	for (const branch of manifest.previews) {
		if (branch.deletion) throw new Error("Finish pending Preview cleanup before verifying history.");
		const latest = branch.revisions.at(-1);
		if (!latest?.caller || latest.target.verified === false || latest.caller.verified === false) throw new Error("Finish pending verification of the Preview pair.");
		const stable = await verify(`${branch.target.url}/health`, (body) => body.versionId === latest.target.versionId && body.environment === "preview" && body.previewKey === branch.key && body.release === latest.release && body.responseVariant === latest.variant, `${branch.key} stable URL`);
		checks.push({ name: `${branch.key}: stable branch`, passed: true, at: new Date().toISOString(), targetVersionId: stable.versionId });
		for (const entry of branch.revisions) {
			if (!entry.caller || entry.target.verified === false || entry.caller.verified === false) throw new Error("Incomplete Preview verification receipt.");
			const fixed = await verify(`${entry.target.url}/health`, (body) => body.versionId === entry.target.versionId && body.environment === "preview" && body.previewKey === branch.key && body.release === entry.release && body.responseVariant === entry.variant, `${entry.key} fixed target`);
			checks.push({ name: `${entry.key}: fixed target`, passed: true, at: new Date().toISOString(), targetVersionId: fixed.versionId });
			const moving = await verify(`${entry.caller.url}/probe`,
				(body) => body.caller?.versionId === entry.caller.versionId && body.upstream?.body?.versionId === latest.target.versionId,
				`${entry.key} fixed caller, moving target`);
			checks.push({ name: `${entry.key}: caller fixed / target moving`, passed: true, at: new Date().toISOString(), callerVersionId: moving.caller.versionId, targetVersionId: moving.upstream.body.versionId });
			const pinned = await verify(`${entry.caller.url}/probe?deployment=pinned`,
				(body) => body.caller?.versionId === entry.caller.versionId && body.upstream?.body?.versionId === entry.target.versionId && body.matchesExpectedVersion === true,
				`${entry.key} both hops fixed`);
			checks.push({ name: `${entry.key}: both hops pinned`, passed: true, at: new Date().toISOString(), callerVersionId: pinned.caller.versionId, targetVersionId: pinned.upstream.body.versionId });
		}
	}
	manifest.checks = [...manifest.checks.filter((entry) => !checks.some((check) => check.name === entry.name)), ...checks];
	save(manifest);
	return checks;
}

export async function cleanupPreview(name, { account = assertAccountSelected(), run = runWrangler, lookup = getNamedPreview,
	own = assertOwnedWorker, load = readManifest, save = writeManifest,
} = {}) {
	if (process.env.WRANGLER_CI_OVERRIDE_NAME) throw new Error("Unset WRANGLER_CI_OVERRIDE_NAME before Preview cleanup.");
	const manifest = load();
	assertManifestOwner(manifest, account.id);
	if (!PREVIEW_KEY.test(name)) throw new Error("Invalid reserved Preview key.");
	const branch = manifest.previews.find((entry) => entry.key === name);
	if (!branch) throw new Error("Refusing to delete a Preview absent from the local ownership record.");
	await checkParents(manifest, own);
	const resources = [
		{ role: "caller", worker: CALLER_WORKER, config: CALLER_CONFIG, record: branch.caller },
		{ role: "target", worker: TARGET_WORKER, config: TARGET_CONFIG, record: branch.target },
	];
	// Reconcile both resource IDs before deleting either; confirmed absence is resumable.
	for (const item of resources) {
		if (!item.record) continue;
		const remote = await lookup(account.id, item.worker, item.record.slug);
		if (remote) assertPreviewOwnership(remote, item.record, name);
	}
	branch.deletion ??= { caller: false, target: false };
	save(manifest);
	for (const item of resources) {
		if (branch.deletion[item.role]) continue;
		if (item.record) {
			const remote = await lookup(account.id, item.worker, item.record.slug);
			if (remote) {
				assertPreviewOwnership(remote, item.record, name);
				run(["preview", "delete", "--config", item.config, "--worker-name", item.worker, "--name", item.record.name, "--skip-confirmation"]);
				if (await lookup(account.id, item.worker, item.record.slug)) throw new Error("Preview deletion has not completed. Rerun cleanup to reconcile it.");
			}
		}
		branch.deletion[item.role] = true;
		save(manifest); // Preserve caller progress even if deleting target subsequently fails.
	}
	manifest.previews = manifest.previews.filter((item) => item.key !== name);
	manifest.checks = manifest.checks.filter((item) => !item.name.startsWith(`${name}:`) && !item.name.startsWith(`${name}-`));
	save(manifest);
	console.log(`Deleted ${name}. Redeploy the production showcase to remove its archived buttons.`);
}
