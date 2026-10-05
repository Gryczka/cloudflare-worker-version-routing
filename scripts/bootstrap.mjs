/** Creates the Preview-led lab, then activates the verified production showcase. */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { accountSubdomain } from "./cloudflare-api.mjs";
import { assertOwnedWorker } from "./ownership.mjs";
import { emptyManifest, origin } from "./manifest.mjs";
import { checkBundles } from "./check-previews.mjs";
import { deployPreviewPair, verifyPreviewHistory } from "./previews.mjs";
import { verifyRoutingLab } from "./verify-live.mjs";
import {
	CALLER_CONFIG, CALLER_WORKER, TARGET_CONFIG, TARGET_WORKER,
	assertAccountSelected, assertManifestAccount, assertManifestOwner, callerVarArgs,
	getOrigins, parseVersionId, parseWorkersDevSubdomain, printDryRun, readManifest,
	runWrangler, targetVarArgs, verifyEndpoint, workerExists, writeManifest,
} from "./wrangler.mjs";

const { values } = parseArgs({ options: {
	help: { type: "boolean" }, "dry-run": { type: "boolean" }, force: { type: "boolean" },
	"ui-origin": { type: "string", multiple: true },
}, strict: true, allowPositionals: false });
if (values.help) {
	console.log("Usage: npm run bootstrap -- [--dry-run] [--force] [--ui-origin https://your-showcase.example]");
	process.exit(0);
}

const account = assertAccountSelected();
const previous = readManifest();
if (previous.accountId) assertManifestAccount(previous, account.id);
const targetExists = workerExists(TARGET_WORKER);
const callerExists = workerExists(CALLER_WORKER);
if (targetExists || callerExists) {
	if (!values.force) throw new Error("A fixed lab Worker name already exists. Inspect ownership and pass --force only for your recorded lab.");
	assertManifestAccount(previous, account.id);
	if (targetExists) await assertOwnedWorker(previous, TARGET_WORKER);
	if (callerExists) await assertOwnedWorker(previous, CALLER_WORKER);
}
const uiOrigins = [...new Set([...previous.uiOrigins, ...(values["ui-origin"] ?? []).map(origin)])];
if (values["dry-run"]) {
	checkBundles();
	printDryRun();
	process.exit(0);
}
if (process.env.WRANGLER_CI_OVERRIDE_NAME) throw new Error("Unset WRANGLER_CI_OVERRIDE_NAME before creating the paired lab.");

let activated = false;
try {
	const subdomain = await accountSubdomain(account.id);
	let manifest = { ...previous, accountId: account.id, labId: previous.labId || randomUUID(), workersDevSubdomain: subdomain, uiOrigins };
	if (!targetExists) {
		manifest = { ...emptyManifest(), accountId: account.id, labId: manifest.labId, workersDevSubdomain: subdomain, uiOrigins };
		writeManifest(manifest); // Ownership precedes the first cloud mutation.
		const baseline = runWrangler(["deploy", "--config", TARGET_CONFIG, ...targetVarArgs("production", subdomain)]);
		if (parseWorkersDevSubdomain(baseline) !== subdomain) throw new Error("Deployment URL differs from the selected account's subdomain.");
		manifest.productionVersionId = parseVersionId(baseline);
		writeManifest(manifest);
	} else {
		writeManifest(manifest);
		const current = await assertOwnedWorker(manifest, TARGET_WORKER);
		if (current.identity.labId !== manifest.labId) {
			const output = runWrangler(["versions", "upload", "--config", TARGET_CONFIG, ...targetVarArgs("production", subdomain), "--message", "Add verified lab ownership marker"]);
			manifest.productionVersionId = parseVersionId(output);
			runWrangler(["versions", "deploy", "--config", TARGET_CONFIG, `${manifest.productionVersionId}@100`, ...(manifest.candidateVersionId ? [`${manifest.candidateVersionId}@0`] : []), "--yes"]);
			writeManifest(manifest);
		}
	}
	const { targetOrigin, callerOrigin } = getOrigins(subdomain);
	const productionBefore = await verifyEndpoint(`${targetOrigin}/health`, (body) => body.worker === TARGET_WORKER, "owned target Worker");
	if (!callerExists) {
		manifest.callerVersionId = parseVersionId(runWrangler(["deploy", "--config", CALLER_CONFIG, ...callerVarArgs(subdomain, manifest)]));
		writeManifest(manifest);
	} else {
		const current = await assertOwnedWorker(manifest, CALLER_WORKER);
		if (current.identity.labId !== manifest.labId) {
			manifest.callerVersionId = parseVersionId(runWrangler(["deploy", "--config", CALLER_CONFIG, ...callerVarArgs(subdomain, manifest)]));
			writeManifest(manifest);
		}
	}
	await verifyEndpoint(`${callerOrigin}/health`, (body) => body.worker === CALLER_WORKER, "owned caller Worker");

	const candidateOutput = runWrangler(["versions", "upload", "--config", TARGET_CONFIG,
		...targetVarArgs("candidate", subdomain), "--preview-alias", "candidate", "--message", "Production-configured 0% candidate"]);
	const candidateVersionId = parseVersionId(candidateOutput);
	const labVersions = [];
	for (let number = 1; number <= 10; number++) {
		const release = `lab-${String(number).padStart(2, "0")}`;
		const output = runWrangler(["versions", "upload", "--config", TARGET_CONFIG,
			...targetVarArgs(release, subdomain), "--preview-alias", release, "--message", `Uploaded-version lab ${release}`]);
		labVersions.push({ release, id: parseVersionId(output) });
	}
	manifest = { ...manifest, candidateVersionId, labVersions };
	writeManifest(manifest);
	for (const scenario of [
		{ name: "branch-ui", revision: "r1", variant: "compact" },
		{ name: "branch-ui", revision: "r2", variant: "detailed" },
		{ name: "branch-api", revision: "r1", variant: "detailed" },
	]) {
		const recorded = readManifest().previews.find((branch) => branch.key === scenario.name)?.revisions.find((entry) => entry.key === `${scenario.name}-${scenario.revision}`);
		if (!recorded?.caller || recorded.target.verified === false || recorded.caller.verified === false) await deployPreviewPair({ ...scenario, account });
	}
	await verifyPreviewHistory({ account });
	await verifyEndpoint(`${targetOrigin}/health`, (body) => body.versionId === productionBefore.versionId, "production unchanged by all Preview deployments");
	manifest = readManifest();
	manifest.checks = manifest.checks.filter((check) => check.name !== "production: unchanged by Preview deployments");
	manifest.checks.push({ name: "production: unchanged by Preview deployments", passed: true, at: new Date().toISOString(), targetVersionId: productionBefore.versionId });
	writeManifest(manifest);

	const output = runWrangler(["versions", "upload", "--config", TARGET_CONFIG,
		...targetVarArgs("production", subdomain), "--message", "Preview-led production showcase"]);
	manifest.productionVersionId = parseVersionId(output);
	runWrangler(["versions", "deploy", "--config", TARGET_CONFIG,
		`${manifest.productionVersionId}@100`, `${candidateVersionId}@0`, "--yes"]);
	activated = true;
	writeManifest(manifest);
	await verifyEndpoint(`${targetOrigin}/health`, (body) => body.versionId === manifest.productionVersionId, "production showcase");
	manifest.callerVersionId = parseVersionId(runWrangler(["deploy", "--config", CALLER_CONFIG, ...callerVarArgs(subdomain, manifest)]));
	writeManifest(manifest);
	await verifyRoutingLab({ account });
	console.log(`\nShowcase: ${targetOrigin}\nCaller: ${callerOrigin}/probe`);
} catch (error) {
	if (!activated && targetExists && previous.candidateVersionId) {
		const partial = readManifest();
		// Preserve new Preview receipts while restoring the production-version ownership record.
		writeManifest({ ...previous, labId: partial.labId, productionVersionId: partial.productionVersionId, callerVersionId: partial.callerVersionId, previews: partial.previews, checks: partial.checks, uiOrigins });
	}
	throw error;
}
