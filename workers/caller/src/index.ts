/**
 * Routes diagnostic requests to production, aliased, and fixed Worker Version URLs.
 *
 * `global_fetch_strictly_public` is intentionally enabled for this Worker so global
 * fetch calls to same-account workers.dev hosts traverse Cloudflare's public edge.
 */

type ProbeMode = "production" | "version" | "uploaded" | "alias";

const SELECTOR_KEYS = ["version", "uploaded", "alias"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALIAS = /^[a-z][a-z0-9-]{0,31}$/;

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const responseHeaders = {
			"access-control-allow-origin": new URL(env.TARGET_ORIGIN).origin,
			"cache-control": "no-store",
		};

		if (url.pathname === "/health") {
			return Response.json({
				ok: true,
				worker: "worker-version-routing-caller",
				versionId: env.CF_VERSION_METADATA.id,
				targetOrigin: env.TARGET_ORIGIN,
			}, { headers: responseHeaders });
		}

		if (url.pathname !== "/probe") {
			return Response.json({
				worker: "worker-version-routing-caller",
				usage: {
					production: "/probe",
					versionOverride: "/probe?version=<version-uuid>",
					uploadedVersion: "/probe?uploaded=<version-uuid>",
					alias: "/probe?alias=<version-alias>",
				},
			}, { status: 404, headers: responseHeaders });
		}

		const version = url.searchParams.get("version");
		const uploaded = url.searchParams.get("uploaded");
		const alias = url.searchParams.get("alias");
		const selectorCount = SELECTOR_KEYS.filter((key) => url.searchParams.has(key)).length;
		const hasDuplicates = SELECTOR_KEYS.some((key) => url.searchParams.getAll(key).length > 1);

		if (selectorCount > 1 || hasDuplicates || [version, uploaded, alias].some((value) => value === "") ||
			(version && !UUID.test(version)) || (uploaded && !UUID.test(uploaded)) || (alias && !ALIAS.test(alias))) {
			return Response.json({ error: "Choose one valid version ID or alias." }, { status: 400, headers: responseHeaders });
		}

		const mode: ProbeMode = uploaded ? "uploaded" : alias ? "alias" : version ? "version" : "production";
		const versionHost = `${env.TARGET_WORKER_NAME}.${env.WORKERS_DEV_SUBDOMAIN}.workers.dev`;
		const targetUrl = uploaded
			? `https://${uploaded.slice(0, 8)}-${versionHost}/api/invoke`
			: alias
				? `https://${alias}-${versionHost}/api/invoke`
				: new URL("/api/invoke", env.TARGET_ORIGIN).href;
		const headers = new Headers();

		if (version) {
			headers.set("Cloudflare-Workers-Version-Overrides", `${env.TARGET_WORKER_NAME}="${version}"`);
		}

		const started = Date.now();
		let upstream: Response;
		let upstreamBody: string;
		try {
			// Version overrides are supported on fetch-style service binding calls.
			const init = { headers, signal: AbortSignal.timeout(10_000) };
			upstream = version
				? await env.TARGET.fetch(targetUrl, init)
				: await fetch(targetUrl, init);
			upstreamBody = await readLimitedBody(upstream);
		} catch (error) {
			console.error(JSON.stringify({ event: "target_request_failed", mode, error: String(error) }));
			return Response.json({ error: "Target request failed", mode }, { status: 502, headers: responseHeaders });
		}

		return Response.json({
			mode,
			requested: { version, uploaded, alias, url: targetUrl },
			caller: {
				worker: "worker-version-routing-caller",
				versionId: env.CF_VERSION_METADATA.id,
			},
			upstream: {
				status: upstream.status,
				elapsedMs: Date.now() - started,
				body: parseBody(upstreamBody),
			},
		}, { status: upstream.ok ? 200 : 502, headers: responseHeaders });
	},
} satisfies ExportedHandler<Env>;

/** Parses target JSON while retaining Cloudflare plaintext error responses. */
function parseBody(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch {
		return body;
	}
}

/** Reads at most 64 KiB so a stale or reassigned version cannot exhaust memory. */
async function readLimitedBody(response: Response, limit = 64 * 1024): Promise<string> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > limit) throw new Error("Target response exceeds 64 KiB");
	if (!response.body) return "";

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel();
			throw new Error("Target response exceeds 64 KiB");
		}
		chunks.push(value);
	}

	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}
