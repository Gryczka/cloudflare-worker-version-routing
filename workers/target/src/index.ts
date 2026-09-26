/** Target Worker that identifies the exact uploaded version handling each request. */
import versionManifest from "./versions.generated.json";
import { renderPage } from "./ui";

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const identity = {
			worker: env.WORKER_NAME,
			release: env.RELEASE,
			versionId: env.CF_VERSION_METADATA.id,
			hostname: url.hostname,
			path: url.pathname,
		};

		if (url.pathname === "/health" || url.pathname === "/api/invoke") {
			return Response.json({ ok: true, ...identity }, { headers: { "cache-control": "no-store" } });
		}

		if (url.pathname === "/" || url.pathname === "/ui") {
			return new Response(renderPage({
				worker: env.WORKER_NAME,
				version: env.CF_VERSION_METADATA.id,
				targetOrigin: url.origin,
				callerOrigin: env.CALLER_ORIGIN,
				workersDevSubdomain: env.WORKERS_DEV_SUBDOMAIN,
				candidateVersionId: versionManifest.candidateVersionId,
				labVersions: versionManifest.labVersions,
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
