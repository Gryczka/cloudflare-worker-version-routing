/** Uploads an updated target and atomically preserves the candidate at 0% traffic. */
import { parseArgs } from "node:util";
import {
	TARGET_CONFIG,
	assertAccountSelected,
	assertManifestOwner,
	getOrigins,
	parseVersionId,
	readManifest,
	runWrangler,
	targetVarArgs,
	verifyEndpoint,
} from "./wrangler.mjs";

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: { help: { type: "boolean" }, force: { type: "boolean" } },
	strict: true,
	allowPositionals: false,
});
if (values.help) {
	console.log("Usage: npm run deploy:target -- --force");
	process.exit(0);
}
if (!values.force) throw new Error("This command replaces the named target Worker. Pass --force to confirm.");

const account = assertAccountSelected();
const manifest = readManifest();
const subdomain = assertManifestOwner(manifest, account.id);
const { candidateVersionId } = manifest;
if (!candidateVersionId) throw new Error("Run npm run bootstrap before deploying target updates.");

const output = runWrangler([
	"versions", "upload", "--config", TARGET_CONFIG,
	...targetVarArgs("production", subdomain),
	"--message", "Version routing production UI update",
]);
const productionVersionId = parseVersionId(output);
runWrangler([
	"versions", "deploy", "--config", TARGET_CONFIG,
	`${productionVersionId}@100`, `${candidateVersionId}@0`, "--yes",
]);
const { targetOrigin } = getOrigins(subdomain);
await verifyEndpoint(`${targetOrigin}/health`, (body) => body.versionId === productionVersionId, "production target version");
