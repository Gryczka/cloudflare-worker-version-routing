/** Deployed acceptance checks: compare actual runtime version IDs, not just HTTP status. */
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
	TARGET_WORKER, assertAccountSelected, assertManifestOwner, getOrigins,
	readManifest, showcaseOrigins, verifyEndpoint, writeManifest,
} from "./wrangler.mjs";

export async function verifyRoutingLab({ account = assertAccountSelected(), callerOrigin } = {}) {
	const manifest = readManifest();
	const subdomain = assertManifestOwner(manifest, account.id);
	callerOrigin ??= getOrigins(subdomain).callerOrigin;
	const checks = [];
	const probe = async (query, expected, name) => {
		const result = await verifyEndpoint(`${callerOrigin}/probe${query ? `?${query}` : ""}`,
			(body) => body.caller?.versionId === manifest.callerVersionId && body.upstream?.body?.worker === TARGET_WORKER && body.upstream?.body?.versionId === expected,
			name);
		checks.push({ name, passed: true, at: new Date().toISOString(), callerVersionId: result.caller.versionId, targetVersionId: result.upstream.body.versionId });
	};
	await probe("", manifest.productionVersionId, "production: routing");
	for (const branch of manifest.previews) {
		await probe(`preview=${branch.key}`, branch.revisions.at(-1).target.versionId, `${branch.key}: production caller to stable Preview`);
		for (const revision of branch.revisions) await probe(`deployment=${revision.key}`, revision.target.versionId, `${revision.key}: production caller to fixed deployment`);
	}
	for (const entry of manifest.labVersions) await probe(`uploaded=${entry.id}`, entry.id, `${entry.release}: fixed uploaded version`);
	await probe("alias=candidate", manifest.candidateVersionId, "candidate: moving upload alias");
	await probe(`version=${manifest.candidateVersionId}`, manifest.candidateVersionId, "candidate: 0% service-binding override");
	for (const uiOrigin of showcaseOrigins(manifest)) {
		const response = await fetch(`${callerOrigin}/health`, { headers: { origin: uiOrigin }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
		if (!response.ok || response.headers.get("access-control-allow-origin") !== uiOrigin) throw new Error(`CORS verification failed for ${uiOrigin}.`);
		await response.body?.cancel();
	}
	manifest.checks = [...manifest.checks.filter((entry) => !checks.some((check) => check.name === entry.name)), ...checks];
	writeManifest(manifest);
	console.log(`Verified ${checks.length} production-caller routes plus recorded showcase origins.`);
	return checks;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const { values } = parseArgs({ options: { help: { type: "boolean" }, "caller-origin": { type: "string" } }, strict: true, allowPositionals: false });
	if (values.help) console.log("Usage: npm run verify:live -- [--caller-origin https://your-caller.example]");
	else await verifyRoutingLab({ callerOrigin: values["caller-origin"] });
}
