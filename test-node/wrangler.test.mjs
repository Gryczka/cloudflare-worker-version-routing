import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	assertManifestAccount,
	assertManifestOwner,
	getOrigins,
	parseVersionId,
	parseWorkersDevSubdomain,
} from "../scripts/wrangler.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

test("parses IDs from upload and deploy output", () => {
	const id = "11111111-1111-4111-8111-111111111111";
	assert.equal(parseVersionId(`Worker Version ID: ${id}`), id);
	assert.equal(parseVersionId(`Current Version ID: ${id}`), id);
	assert.throws(() => parseVersionId("upload complete"), /Could not parse/);
});

test("discovers the workers.dev subdomain from target deploy output", () => {
	const output = "https://worker-version-routing-target.example-team.workers.dev";
	assert.equal(parseWorkersDevSubdomain(output), "example-team");
	assert.deepEqual(getOrigins("example-team"), {
		targetOrigin: "https://worker-version-routing-target.example-team.workers.dev",
		callerOrigin: "https://worker-version-routing-caller.example-team.workers.dev",
	});
});

test("refuses a generated manifest from another account", () => {
	const manifest = {
		accountId: "a".repeat(32),
		workersDevSubdomain: "example-team",
		candidateVersionId: "11111111-1111-4111-8111-111111111111",
		labVersions: [],
	};
	assert.equal(assertManifestOwner(manifest, manifest.accountId), "example-team");
	assert.equal(assertManifestAccount(manifest, manifest.accountId), manifest);
	assert.throws(() => assertManifestAccount(manifest, "b".repeat(32)), /different Cloudflare account/);
	assert.throws(() => assertManifestOwner(manifest, "b".repeat(32)), /different Cloudflare account/);
});

test("rejects unknown bootstrap flags before any deployment work", () => {
	const result = spawnSync(process.execPath, ["scripts/bootstrap.mjs", "--dryrun"], {
		cwd: projectRoot,
		encoding: "utf8",
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Unknown option '--dryrun'/);
});
