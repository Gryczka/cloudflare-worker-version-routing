/** Diagnostic HTTP routing. True Previews deliberately use HTTP rather than a production service binding. */
import rawManifest from "../../target/src/versions.generated.json";
import { ALIAS, KEY, UUID, findRevision, ownedOrigin, type DeploymentManifest } from "../../shared/catalog";

// Wrangler currently generates production types only; Preview callers omit TARGET.
export type CallerEnv = Omit<Env, "TARGET"> & Partial<Pick<Env, "TARGET">>;
type ProbeMode = "production" | "version" | "uploaded" | "alias" | "preview" | "deployment";
const SELECTORS = ["version", "uploaded", "alias", "preview", "deployment"] as const;
/** Explicit catalogs keep tests independent of local/cloud deployment state. */
export function createCaller(manifest: DeploymentManifest) {
	return {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const responseHeaders = corsHeaders(request, env);
		if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders });
		if (request.method !== "GET") return Response.json({ error: "Use GET." }, { status: 405, headers: responseHeaders });
		const caller = {
			worker: "worker-version-routing-caller", versionId: env.CF_VERSION_METADATA.id,
			labId: env.LAB_ID,
			versionTag: env.CF_VERSION_METADATA.tag, versionTimestamp: env.CF_VERSION_METADATA.timestamp,
			release: env.RELEASE, environment: env.ENVIRONMENT, previewKey: env.PREVIEW_KEY || null,
		};
		if (url.pathname === "/health") {
			return Response.json({ ok: true, ...caller, targetOrigin: env.TARGET_ORIGIN, pinnedTargetOrigin: env.PINNED_TARGET_ORIGIN }, { headers: responseHeaders });
		}
		if (url.pathname !== "/probe") {
			return Response.json({ worker: caller.worker, usage: {
				production: "/probe", branch: "/probe?preview=<recorded-branch-key>",
				fixedDeployment: "/probe?deployment=<recorded-revision-key>",
				pinnedPreviewTarget: "/probe?deployment=pinned (Preview caller only)",
				versionOverride: "/probe?version=<version-uuid>", uploadedVersion: "/probe?uploaded=<version-uuid>", alias: "/probe?alias=<version-alias>",
			} }, { status: 404, headers: responseHeaders });
		}

		const invalidQuery = [...url.searchParams.keys()].some((key) => !(SELECTORS as readonly string[]).includes(key)) ||
			SELECTORS.filter((key) => url.searchParams.has(key)).length > 1 ||
			SELECTORS.some((key) => url.searchParams.has(key) && (url.searchParams.getAll(key).length !== 1 || !url.searchParams.get(key)));
		if (invalidQuery) return Response.json({ error: "Choose exactly one valid route selector." }, { status: 400, headers: responseHeaders });

		const version = url.searchParams.get("version");
		const uploaded = url.searchParams.get("uploaded");
		const alias = url.searchParams.get("alias");
		const preview = url.searchParams.get("preview");
		const deployment = url.searchParams.get("deployment");
		if ((version && !UUID.test(version)) || (uploaded && !UUID.test(uploaded)) || (alias && !ALIAS.test(alias)) ||
			(preview && !KEY.test(preview)) || (deployment && !KEY.test(deployment))) {
			return Response.json({ error: "Invalid version, alias, or recorded Preview key." }, { status: 400, headers: responseHeaders });
		}
		if (env.ENVIRONMENT === "preview" && (version || uploaded || alias)) {
			return Response.json({ error: "Production version-routing modes are unavailable in a Preview." }, { status: 400, headers: responseHeaders });
		}

		let mode: ProbeMode = env.ENVIRONMENT === "preview" ? "preview" : "production";
		let targetOrigin = env.TARGET_ORIGIN;
		let expectedVersionId: string | null = null;
		let previewId: string | null = null;
		let deploymentId: string | null = null;
		if (env.ENVIRONMENT === "preview") {
			if (preview && preview !== env.PREVIEW_KEY) return Response.json({ error: "This caller belongs to a different Preview." }, { status: 404, headers: responseHeaders });
			if (deployment) {
				if (deployment !== "pinned") return Response.json({ error: "Use deployment=pinned in a Preview caller." }, { status: 404, headers: responseHeaders });
				mode = "deployment";
				targetOrigin = env.PINNED_TARGET_ORIGIN;
				expectedVersionId = env.PINNED_TARGET_VERSION_ID;
			}
		} else if (preview) {
			const branch = manifest.previews.find((entry) => entry.key === preview && !entry.deletion);
			const latest = branch?.revisions.at(-1);
			if (!branch || !latest || latest.target.verified === false) return Response.json({ error: "Unknown or unverified recorded Preview." }, { status: 404, headers: responseHeaders });
			mode = "preview"; targetOrigin = branch.target.url; previewId = branch.target.id;
			expectedVersionId = latest.target.versionId;
		} else if (deployment) {
			const revision = findRevision(manifest.previews.filter((branch) => !branch.deletion), deployment);
			if (!revision || revision.target.verified === false) return Response.json({ error: "Unknown or unverified Preview deployment." }, { status: 404, headers: responseHeaders });
			mode = "deployment"; targetOrigin = revision.target.url; deploymentId = revision.target.id;
			expectedVersionId = revision.target.versionId;
		} else if (uploaded || alias) {
			mode = uploaded ? "uploaded" : "alias";
			const prefix = uploaded ? uploaded.slice(0, 8) : alias;
			targetOrigin = `https://${prefix}-${env.TARGET_WORKER_NAME}.${env.WORKERS_DEV_SUBDOMAIN}.workers.dev`;
			expectedVersionId = uploaded;
		} else if (version) {
			if (!env.TARGET) return Response.json({ error: "Production service binding is missing." }, { status: 503, headers: responseHeaders });
			mode = "version"; expectedVersionId = version;
		}

		const traceId = crypto.randomUUID();
		const started = Date.now();
		let targetUrl: string;
		let upstream: Response;
		let body: unknown;
		try {
			targetUrl = `${ownedOrigin(targetOrigin, env.TARGET_WORKER_NAME, env.WORKERS_DEV_SUBDOMAIN)}/api/invoke`;
			const headers = new Headers({ "x-demo-trace-id": traceId });
			if (version) headers.set("Cloudflare-Workers-Version-Overrides", `${env.TARGET_WORKER_NAME}="${version}"`);
			const init = { headers, signal: AbortSignal.timeout(10_000), redirect: "manual" as const };
			upstream = version && env.TARGET ? await env.TARGET.fetch(targetUrl, init) : await fetch(targetUrl, init);
			body = parseBody(await readLimitedBody(upstream));
		} catch (error) {
			console.error(JSON.stringify({ event: "target_request_failed", traceId, mode, error: String(error) }));
			return Response.json({ error: "Target request failed", mode, traceId }, { status: 502, headers: responseHeaders });
		}
		const actualVersionId = isIdentity(body) ? body.versionId : null;
		const matchesExpectedVersion = expectedVersionId ? actualVersionId === expectedVersionId : null;
		console.log(JSON.stringify({ event: "probe", traceId, mode, callerVersionId: caller.versionId, targetVersionId: actualVersionId, status: upstream.status, matchesExpectedVersion }));
		return Response.json({
			mode, traceId,
			requested: { version, uploaded, alias, preview, deployment, url: targetUrl, previewId, deploymentId, expectedVersionId },
			caller,
			upstream: { status: upstream.status, elapsedMs: Date.now() - started, body },
			matchesExpectedVersion,
		}, { status: upstream.ok ? 200 : 502, headers: responseHeaders });
	},
	} satisfies ExportedHandler<CallerEnv>;
}

export default createCaller(rawManifest);

function corsHeaders(request: Request, env: CallerEnv): Record<string, string> {
	const headers: Record<string, string> = {
		"cache-control": "no-store", "x-content-type-options": "nosniff", "vary": "Origin",
		"access-control-allow-methods": "GET, OPTIONS",
	};
	try {
		const origins: unknown = JSON.parse(env.UI_ORIGINS);
		const requested = request.headers.get("origin");
		if (Array.isArray(origins) && requested && origins.includes(requested)) headers["access-control-allow-origin"] = requested;
		else if (!requested) headers["access-control-allow-origin"] = new URL(env.TARGET_ORIGIN).origin;
	} catch { /* A malformed deployment setting must not broaden allowed origins. */ }
	return headers;
}

function isIdentity(body: unknown): body is { versionId: string } {
	return typeof body === "object" && body !== null && "versionId" in body && typeof body.versionId === "string";
}

function parseBody(body: string): unknown {
	try { return JSON.parse(body); } catch { return body; }
}

/** Inspect small diagnostic bodies, bounded even when Content-Length is absent. */
async function readLimitedBody(response: Response, limit = 64 * 1024): Promise<string> {
	const length = Number(response.headers.get("content-length"));
	if (Number.isFinite(length) && length > limit) throw new Error("Target response exceeds 64 KiB");
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) { await reader.cancel(); throw new Error("Target response exceeds 64 KiB"); }
			chunks.push(value);
		}
	} finally { reader.releaseLock(); }
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
	return new TextDecoder().decode(body);
}
