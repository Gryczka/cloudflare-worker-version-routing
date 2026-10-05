/** Deploys the caller only after confirming the account in the generated manifest. */
import { parseArgs } from "node:util";
import { assertOwnedWorker } from "./ownership.mjs";
import {
	CALLER_CONFIG,
	CALLER_WORKER,
	assertAccountSelected,
	assertManifestOwner,
	callerVarArgs,
	getOrigins,
	parseVersionId,
	readManifest,
	runWrangler,
	verifyEndpoint,
	writeManifest,
} from "./wrangler.mjs";

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: { help: { type: "boolean" }, force: { type: "boolean" } },
	strict: true,
	allowPositionals: false,
});
if (values.help) {
	console.log("Usage: npm run deploy:caller -- --force");
	process.exit(0);
}
if (!values.force) throw new Error("This command replaces the named caller Worker. Pass --force to confirm.");

const account = assertAccountSelected();
const manifest = readManifest();
const subdomain = assertManifestOwner(manifest, account.id);
await assertOwnedWorker(manifest, CALLER_WORKER);
const output = runWrangler(["deploy", "--config", CALLER_CONFIG, ...callerVarArgs(subdomain, manifest)]);
manifest.callerVersionId = parseVersionId(output);
writeManifest(manifest);
const { callerOrigin } = getOrigins(subdomain);
await verifyEndpoint(`${callerOrigin}/health`, (body) => body.worker === CALLER_WORKER && body.versionId === manifest.callerVersionId, "caller Worker");
