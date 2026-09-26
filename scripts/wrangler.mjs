/** Shared, side-effect-free configuration plus Wrangler process helpers. */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const TARGET_CONFIG = "workers/target/wrangler.jsonc";
export const CALLER_CONFIG = "workers/caller/wrangler.jsonc";
export const MANIFEST_PATH = fileURLToPath(new URL("../workers/target/src/versions.generated.json", import.meta.url));
export const TARGET_WORKER = "worker-version-routing-target";
export const CALLER_WORKER = "worker-version-routing-caller";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const WRANGLER = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

/** Returns the public origins created by the two Worker names. */
export function getOrigins(subdomain) {
	return {
		targetOrigin: `https://${TARGET_WORKER}.${subdomain}.workers.dev`,
		callerOrigin: `https://${CALLER_WORKER}.${subdomain}.workers.dev`,
	};
}

/** Builds all target vars so CLI overrides never leave account-specific defaults behind. */
export function targetVarArgs(release, subdomain) {
	const { callerOrigin } = getOrigins(subdomain);
	return [
		"--var", `RELEASE:${release}`,
		"--var", `WORKER_NAME:${TARGET_WORKER}`,
		"--var", `CALLER_ORIGIN:${callerOrigin}`,
		"--var", `WORKERS_DEV_SUBDOMAIN:${subdomain}`,
	];
}

/** Builds all caller vars for the selected account's workers.dev subdomain. */
export function callerVarArgs(subdomain) {
	const { targetOrigin } = getOrigins(subdomain);
	return [
		"--var", `TARGET_ORIGIN:${targetOrigin}`,
		"--var", `TARGET_WORKER_NAME:${TARGET_WORKER}`,
		"--var", `WORKERS_DEV_SUBDOMAIN:${subdomain}`,
	];
}

/** Runs Wrangler through the project's pinned dependency and returns stdout. */
export function runWrangler(args, { print = true } = {}) {
	if (!existsSync(WRANGLER)) throw new Error("Wrangler is not installed. Run npm ci first.");
	const output = execFileSync(process.execPath, [WRANGLER, ...args], {
		cwd: PROJECT_ROOT,
		encoding: "utf8",
		stdio: ["inherit", "pipe", "inherit"],
	});
	if (print) process.stdout.write(output);
	return output;
}

/** Confirms authentication and requires an explicit account for multi-account users. */
export function assertAccountSelected() {
	const identity = JSON.parse(runWrangler(["whoami", "--json"], { print: false }));
	if (!identity.loggedIn) throw new Error("Wrangler is not authenticated. Run npx wrangler login.");
	if (identity.accounts.length > 1 && !process.env.CLOUDFLARE_ACCOUNT_ID) {
		throw new Error("Multiple accounts are available. Set CLOUDFLARE_ACCOUNT_ID before deploying.");
	}
	if (process.env.CLOUDFLARE_ACCOUNT_ID && !identity.accounts.some(({ id }) => id === process.env.CLOUDFLARE_ACCOUNT_ID)) {
		throw new Error("CLOUDFLARE_ACCOUNT_ID is not available to the authenticated user.");
	}
	const account = process.env.CLOUDFLARE_ACCOUNT_ID
		? identity.accounts.find(({ id }) => id === process.env.CLOUDFLARE_ACCOUNT_ID)
		: identity.accounts[0];
	if (!account) throw new Error("No Cloudflare account is available to Wrangler.");
	console.log(`Cloudflare account: ${account.name}`);
	return account;
}

/** Checks for a name collision without treating a missing Worker as an error. */
export function workerExists(name) {
	if (!existsSync(WRANGLER)) throw new Error("Wrangler is not installed. Run npm ci first.");
	const result = spawnSync(process.execPath, [WRANGLER, "deployments", "list", "--name", name, "--json"], {
		cwd: PROJECT_ROOT,
		encoding: "utf8",
	});
	if (result.status === 0) return true;
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	if (output.includes("[code: 10007]") || output.includes("does not exist on your account")) return false;
	throw new Error(`Could not check whether ${name} exists.\n${output.trim()}`);
}

/** Extracts a UUID from either a version upload or production deploy response. */
export function parseVersionId(output) {
	const id = output.match(/(?:Worker Version ID|Current Version ID):\s*([0-9a-f-]{36})/)?.[1];
	if (!id || !UUID.test(id)) throw new Error("Could not parse a Worker version ID from Wrangler output.");
	return id;
}

/** Extracts the selected account's workers.dev subdomain from Wrangler deploy output. */
export function parseWorkersDevSubdomain(output) {
	const subdomain = output.match(new RegExp(`https://${TARGET_WORKER}\\.([a-z0-9-]+)\\.workers\\.dev`))?.[1];
	if (!subdomain || !SUBDOMAIN.test(subdomain)) throw new Error("Could not parse the workers.dev subdomain from Wrangler output.");
	return subdomain;
}

/** Replaces the generated manifest after validating every captured UUID. */
export function writeManifest(manifest) {
	if (!Array.isArray(manifest.labVersions)) throw new Error("Refusing to write a manifest with invalid lab versions.");
	const ids = manifest.labVersions.map(({ id }) => id);
	if (manifest.candidateVersionId && !UUID.test(manifest.candidateVersionId)) throw new Error("Refusing to write a manifest with an invalid candidate version ID.");
	if (!manifest.candidateVersionId && ids.length > 0) throw new Error("Refusing lab versions without a candidate version.");
	if (ids.some((id) => !UUID.test(id))) throw new Error("Refusing to write a manifest with an invalid lab version ID.");
	if (!/^[0-9a-f]{32}$/.test(manifest.accountId)) throw new Error("Refusing to write a manifest with an invalid account ID.");
	if (manifest.workersDevSubdomain && !SUBDOMAIN.test(manifest.workersDevSubdomain)) throw new Error("Refusing to write a manifest with an invalid workers.dev subdomain.");
	const temporaryPath = `${MANIFEST_PATH}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, "\t")}\n`, { mode: 0o600 });
		renameSync(temporaryPath, MANIFEST_PATH);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

/** Reads the generated manifest used by follow-up production deployments. */
export function readManifest() {
	return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

/** Ensures deployment commands target the account that created the ignored manifest. */
export function assertManifestAccount(manifest, accountId) {
	if (manifest.accountId !== accountId) throw new Error("The generated manifest belongs to a different Cloudflare account.");
	return manifest;
}

/** Ensures follow-up commands have both matching ownership and a discovered subdomain. */
export function assertManifestOwner(manifest, accountId) {
	assertManifestAccount(manifest, accountId);
	if (!SUBDOMAIN.test(manifest.workersDevSubdomain ?? "")) throw new Error("The generated manifest has no valid workers.dev subdomain. Run bootstrap first.");
	return manifest.workersDevSubdomain;
}

/** Prints the deployment operations without changing Cloudflare resources. */
export function printDryRun() {
	console.log("Validated deployment plan for the selected Cloudflare account");
	console.log(`1. Refuse collisions for ${TARGET_WORKER} and ${CALLER_WORKER}`);
	console.log("2. Deploy a baseline target and discover its actual workers.dev subdomain");
	console.log("3. Upload candidate alias at 0% plus lab-01 through lab-10");
	console.log("4. Write account, subdomain, and version IDs to the ignored local manifest");
	console.log("5. Upload the target UI and atomically create the 100% production / 0% candidate split");
	console.log("6. Deploy the caller and verify fixed, aliased, and candidate-override routing");
}

/** Retries a public health endpoint to validate the supplied workers.dev subdomain. */
export async function verifyEndpoint(url, predicate, description) {
	for (let attempt = 1; attempt <= 10; attempt += 1) {
		try {
			const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
			const body = await response.json();
			if (response.ok && predicate(body)) return body;
		} catch {
			// Newly deployed workers.dev routes can take a moment to become reachable.
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	throw new Error(`Could not verify ${description} at ${url}. Check the account and workers.dev subdomain.`);
}
