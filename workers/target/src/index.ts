/** Target Worker that identifies the exact uploaded version handling each request. */
import versionManifest from "./versions.generated.json";
import { renderPage } from "./ui";
import type { DeploymentManifest } from "../../shared/catalog";

const manifest: DeploymentManifest = versionManifest;

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const identity = {
			worker: env.WORKER_NAME,
			labId: env.LAB_ID,
			release: env.RELEASE,
			environment: env.ENVIRONMENT,
			previewKey: env.PREVIEW_KEY || null,
			responseVariant: env.RESPONSE_VARIANT,
			versionId: env.CF_VERSION_METADATA.id,
			versionTag: env.CF_VERSION_METADATA.tag,
			versionTimestamp: env.CF_VERSION_METADATA.timestamp,
			hostname: url.hostname,
			path: url.pathname,
		};

		if (url.pathname === "/health" || url.pathname === "/api/invoke") {
			const traceId = request.headers.get("x-demo-trace-id");
			console.log(JSON.stringify({ event: "identity", traceId, ...identity }));
			return Response.json({ ok: true, ...identity, traceId }, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
		}

		if (url.pathname === "/" || url.pathname === "/ui") {
			return new Response(renderPage({
				worker: env.WORKER_NAME,
				version: env.CF_VERSION_METADATA.id,
				targetOrigin: `https://${env.WORKER_NAME}.${env.WORKERS_DEV_SUBDOMAIN}.workers.dev`,
				callerOrigin: env.CALLER_ORIGIN,
				workersDevSubdomain: env.WORKERS_DEV_SUBDOMAIN,
				candidateVersionId: manifest.candidateVersionId,
				labVersions: manifest.labVersions,
				previews: manifest.previews,
				checks: manifest.checks,
				environment: env.ENVIRONMENT,
				previewKey: env.PREVIEW_KEY,
			}), {
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
					"referrer-policy": "no-referrer",
					"x-content-type-options": "nosniff",
					"x-frame-options": "DENY",
				},
			});
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	},
} satisfies ExportedHandler<TargetEnv>;
