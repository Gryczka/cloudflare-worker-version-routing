/** Target Worker that identifies the exact uploaded version handling each request. */
import versionManifest from "./versions.generated.json";
import { renderPage } from "./ui";
import type { DeploymentManifest } from "../../shared/catalog";
import { diagnosticLog, discovery, resourceAnchors } from "../../shared/garden";

const manifest: DeploymentManifest = versionManifest;

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "GET" || request.method === "HEAD") {
			const discovered = discovery(url.pathname);
			if (discovered) return request.method === "HEAD" ? new Response(null, discovered) : discovered;
		}
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
			diagnosticLog({ event: "identity", traceId, versionId: identity.versionId, release: identity.release });
			return Response.json({ ok: true, ...identity, traceId }, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
		}

		if (url.pathname === "/" || url.pathname === "/ui") {
			return new Response(resourceAnchors(renderPage({
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
			})), {
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
					"referrer-policy": "no-referrer",
					"x-content-type-options": "nosniff",
					"x-frame-options": "DENY",
					...(env.ENVIRONMENT === "preview" ? { "x-robots-tag": "noindex, nofollow" } : {}),
				},
			});
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	},
} satisfies ExportedHandler<TargetEnv>;
