/** Creates the complete two-Worker lab without placing lab versions in production traffic. */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
	CALLER_CONFIG,
	CALLER_WORKER,
	MANIFEST_PATH,
	TARGET_CONFIG,
	TARGET_WORKER,
	assertAccountSelected,
	assertManifestAccount,
	assertManifestOwner,
	callerVarArgs,
	getOrigins,
	parseVersionId,
	parseWorkersDevSubdomain,
	printDryRun,
	readManifest,
	runWrangler,
	targetVarArgs,
	verifyEndpoint,
	workerExists,
	writeManifest,
} from "./wrangler.mjs";

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		help: { type: "boolean" },
		"dry-run": { type: "boolean" },
		force: { type: "boolean" },
	},
	strict: true,
	allowPositionals: false,
});
if (values.help) {
	console.log("Usage: npm run bootstrap -- [--dry-run] [--force]");
	process.exit(0);
}

const account = assertAccountSelected();
const force = values.force ?? false;
const previousManifest = readFileSync(MANIFEST_PATH, "utf8");
const previousState = readManifest();
if (previousState.accountId) assertManifestAccount(previousState, account.id);
const targetExists = workerExists(TARGET_WORKER);
const callerExists = workerExists(CALLER_WORKER);
if ((targetExists || callerExists) && !force) {
	throw new Error(`A Worker named ${targetExists ? TARGET_WORKER : CALLER_WORKER} already exists. Refusing to overwrite it; inspect ownership and rerun with --force only for a previous copy of this lab.`);
}
if (values["dry-run"]) {
	runWrangler(["deploy", "--dry-run", "--config", TARGET_CONFIG]);
	runWrangler(["deploy", "--dry-run", "--config", CALLER_CONFIG]);
	printDryRun();
	process.exit(0);
}

let subdomain;
let targetActivated = false;
const restorePreviousManifest = targetExists && Boolean(previousState.candidateVersionId);

try {
	if (targetExists) {
		if (previousState.workersDevSubdomain) {
			subdomain = assertManifestOwner(previousState, account.id);
		} else {
			// Recover a first deploy that completed before Wrangler's output was captured.
			const baseline = runWrangler(["deploy", "--config", TARGET_CONFIG]);
			subdomain = parseWorkersDevSubdomain(baseline);
			writeManifest({ accountId: account.id, workersDevSubdomain: subdomain, candidateVersionId: "", labVersions: [] });
		}
	} else {
		// Record ownership before the first cloud mutation so an interrupted run is recoverable.
		writeManifest({ accountId: account.id, workersDevSubdomain: "", candidateVersionId: "", labVersions: [] });
		const baseline = runWrangler(["deploy", "--config", TARGET_CONFIG]);
		subdomain = parseWorkersDevSubdomain(baseline);
		writeManifest({ accountId: account.id, workersDevSubdomain: subdomain, candidateVersionId: "", labVersions: [] });
	}

	const { targetOrigin, callerOrigin } = getOrigins(subdomain);
	await verifyEndpoint(`${targetOrigin}/health`, (body) => body.worker === TARGET_WORKER, targetExists ? "existing target lab" : "target Worker");
	if (callerExists) await verifyEndpoint(`${callerOrigin}/health`, (body) => body.worker === CALLER_WORKER, "existing caller lab");

	const candidateOutput = runWrangler([
		"versions", "upload", "--config", TARGET_CONFIG,
		...targetVarArgs("candidate", subdomain),
		"--preview-alias", "candidate",
		"--message", "Version routing candidate",
	]);
	const candidateVersionId = parseVersionId(candidateOutput);

	const labVersions = [];
	for (let number = 1; number <= 10; number += 1) {
		const release = `lab-${String(number).padStart(2, "0")}`;
		const output = runWrangler([
			"versions", "upload", "--config", TARGET_CONFIG,
			...targetVarArgs(release, subdomain),
			"--preview-alias", release,
			"--message", `Version routing ${release}`,
		]);
		labVersions.push({ release, id: parseVersionId(output) });
	}

	writeManifest({ accountId: account.id, workersDevSubdomain: subdomain, candidateVersionId, labVersions });
	// Upload first, then atomically change traffic once both deployment versions exist.
	const productionOutput = runWrangler([
		"versions", "upload", "--config", TARGET_CONFIG,
		...targetVarArgs("production", subdomain),
		"--message", "Version routing production UI",
	]);
	const productionVersionId = parseVersionId(productionOutput);
	runWrangler([
		"versions", "deploy", "--config", TARGET_CONFIG,
		`${productionVersionId}@100`, `${candidateVersionId}@0`, "--yes",
	]);
	targetActivated = true;
	await verifyEndpoint(`${targetOrigin}/health`, (body) => body.versionId === productionVersionId, "production target version");

	runWrangler(["deploy", "--config", CALLER_CONFIG, ...callerVarArgs(subdomain)]);
	await verifyEndpoint(`${callerOrigin}/health`, (body) => body.worker === CALLER_WORKER, "caller Worker");
	await verifyEndpoint(
		`${callerOrigin}/probe?uploaded=${labVersions[0].id}`,
		(body) => body.upstream?.body?.versionId === labVersions[0].id,
		"fixed Version URL routing",
	);
	await verifyEndpoint(
		`${callerOrigin}/probe?alias=${labVersions.at(-1).release}`,
		(body) => body.upstream?.body?.versionId === labVersions.at(-1).id,
		"aliased Version URL routing",
	);
	await verifyEndpoint(
		`${callerOrigin}/probe?version=${candidateVersionId}`,
		(body) => body.upstream?.body?.versionId === candidateVersionId,
		"candidate version override routing",
	);
	console.log(`\nTarget UI: ${targetOrigin}`);
	console.log(`Caller API: ${callerOrigin}/probe`);
} catch (error) {
	if (!targetActivated && restorePreviousManifest) writeManifest(JSON.parse(previousManifest));
	throw error;
}
