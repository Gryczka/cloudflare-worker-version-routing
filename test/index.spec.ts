import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../workers/caller/src/index";
import { createCaller, type CallerEnv } from "../workers/caller/src/index";
import target from "../workers/target/src/index";
import { renderPage } from "../workers/target/src/ui";
import fixture from "./preview.fixture.json";
import { ownedOrigin, type DeploymentManifest } from "../workers/shared/catalog";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
afterEach(() => vi.unstubAllGlobals());

describe("caller worker", () => {
	it("returns usage for unknown paths", async () => {
		const response = await worker.fetch(
			new IncomingRequest("https://caller.example/"),
			env,
		);
		expect(response.status).toBe(404);
		const body = await response.json<{ usage: { production: string } }>();
		expect(body.usage.production).toBe("/probe");
	});

	it("rejects aliases that could escape the target Worker hostname", async () => {
		const response = await worker.fetch(
			new IncomingRequest("https://caller.example/probe?alias=outside.example"),
			env,
		);
		expect(response.status).toBe(400);
	});

	it("rejects malformed version IDs and conflicting route selectors", async () => {
		for (const query of [
			"uploaded=outside.example",
			"uploaded=11111111-1111-4111-8111-111111111111&alias=candidate",
			"version=11111111-1111-4111-8111-111111111111&version=22222222-2222-4222-8222-222222222222",
			"preview=branch-ui&deployment=branch-ui-r1",
			"preview=branch-ui&preview=branch-api",
			"preview=",
			"url=https://outside.example",
		]) {
			const response = await worker.fetch(new IncomingRequest(`https://caller.example/probe?${query}`), env);
			expect(response.status).toBe(400);
		}
	});

	it("passes a current-deployment version override through the service binding", async () => {
		const versionId = "11111111-1111-4111-8111-111111111111";
		const response = await worker.fetch(
			new IncomingRequest(`https://caller.example/probe?version=${versionId}`),
			env,
		);
		const body = await response.json<{ mode: string; upstream: { body: { versionId: string } } }>();
		expect(response.status).toBe(200);
		expect(response.headers.get("access-control-allow-origin")).toBe("https://worker-version-routing-target.example.workers.dev");
		expect(body.mode).toBe("version");
		expect(body.upstream.body.versionId).toBe(versionId);
	});

	it("rejects an oversized target response", async () => {
		const versionId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
		const response = await worker.fetch(
			new IncomingRequest(`https://caller.example/probe?version=${versionId}`),
			env,
		);
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ error: "Target request failed", mode: "version" });
	});
});

describe("Preview request routing", () => {
	const caller = createCaller(fixture);
	const branch = fixture.previews[0];
	const first = branch.revisions[0];
	const latest = branch.revisions[1];
	const withoutBinding = ({ TARGET: _binding, ...rest }: Env): CallerEnv => ({
		...rest, ENVIRONMENT: "preview", PREVIEW_KEY: branch.key, RELEASE: first.release,
		TARGET_ORIGIN: branch.target.url, PINNED_TARGET_ORIGIN: first.target.url, PINNED_TARGET_VERSION_ID: first.target.versionId,
		CF_VERSION_METADATA: { id: first.caller.versionId, tag: first.release, timestamp: first.caller.timestamp },
	});

	it("selects recorded stable/fixed provider URLs rather than Worker version prefixes", async () => {
		const fetcher = vi.fn(async (input: string | URL | Request) => Response.json({
			worker: "worker-version-routing-target",
			versionId: String(input).startsWith(first.target.url) ? first.target.versionId : latest.target.versionId,
		}));
		vi.stubGlobal("fetch", fetcher);
		for (const [query, expectedUrl, expectedVersion] of [
			["preview=branch-ui", branch.target.url, latest.target.versionId],
			["deployment=branch-ui-r1", first.target.url, first.target.versionId],
		]) {
			const response = await caller.fetch(new IncomingRequest(`https://caller.example/probe?${query}`), env);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ requested: { url: `${expectedUrl}/api/invoke`, expectedVersionId: expectedVersion }, matchesExpectedVersion: true });
		}
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("keeps a caller fixed while stable and pinned target routes diverge", async () => {
		let movingVersion = first.target.versionId;
		vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => Response.json({
			worker: "worker-version-routing-target",
			versionId: String(input).startsWith(first.target.url) ? first.target.versionId : movingVersion,
		})));
		const previewEnv = withoutBinding(env);
		const before = await caller.fetch(new IncomingRequest("https://fixed-caller.example/probe"), previewEnv);
		expect(await before.json()).toMatchObject({ caller: { versionId: first.caller.versionId }, upstream: { body: { versionId: first.target.versionId } } });
		movingVersion = latest.target.versionId;
		const moving = await caller.fetch(new IncomingRequest("https://fixed-caller.example/probe"), previewEnv);
		expect(await moving.json()).toMatchObject({ caller: { versionId: first.caller.versionId }, upstream: { body: { versionId: latest.target.versionId } } });
		const pinned = await caller.fetch(new IncomingRequest("https://fixed-caller.example/probe?deployment=pinned"), previewEnv);
		expect(await pinned.json()).toMatchObject({ caller: { versionId: first.caller.versionId }, upstream: { body: { versionId: first.target.versionId } }, matchesExpectedVersion: true });
	});

	it("does not fall back to production when a Preview lacks its service binding", async () => {
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		const response = await caller.fetch(new IncomingRequest(`https://caller.example/probe?version=${fixture.candidateVersionId}`), withoutBinding(env));
		expect(response.status).toBe(400);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("rejects unknown recorded keys and unsafe catalog origins without a subrequest", async () => {
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		expect((await caller.fetch(new IncomingRequest("https://caller.example/probe?deployment=unknown"), env)).status).toBe(404);
		const unsafe = structuredClone(fixture);
		unsafe.previews[0].target.url = "https://outside.example";
		expect((await createCaller(unsafe).fetch(new IncomingRequest("https://caller.example/probe?preview=branch-ui"), env)).status).toBe(502);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("reports a redirect rather than following it outside the selected origin", async () => {
		const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 302, headers: { location: "https://outside.example" } }));
		vi.stubGlobal("fetch", fetcher);
		const response = await caller.fetch(new IncomingRequest("https://caller.example/probe?preview=branch-ui"), env);
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ upstream: { status: 302 } });
		expect(fetcher).toHaveBeenCalledOnce();
		expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
	});

	it("hides pending or deleting deployment records without making a subrequest", async () => {
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		for (const deleting of [false, true]) {
			const pending: DeploymentManifest = structuredClone(fixture);
			if (deleting) pending.previews[0].deletion = { caller: true, target: false };
			else pending.previews[0].revisions.at(-1)!.target.verified = false;
			const pendingCaller = createCaller(pending);
			for (const query of ["preview=branch-ui", "deployment=branch-ui-r2"]) {
				expect((await pendingCaller.fetch(new IncomingRequest(`https://caller.example/probe?${query}`), env)).status).toBe(404);
			}
		}
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("reflects only configured UI origins", async () => {
		for (const [origin, allowed] of [["https://showcase.example", true], ["https://outside.example", false]] as const) {
			const response = await caller.fetch(new IncomingRequest("https://caller.example/health", { headers: { origin } }), { ...env, UI_ORIGINS: JSON.stringify(fixture.uiOrigins) });
			expect(response.headers.get("access-control-allow-origin")).toBe(allowed ? origin : null);
			expect(response.headers.get("vary")).toBe("Origin");
		}
	});

	it("rejects credentials, paths, ports, and misleading hostname suffixes", () => {
		for (const value of ["https://user@example.workers.dev", `${branch.target.url}/other`, `${branch.target.url}:444`, `${branch.target.url}.outside.example`]) {
			expect(() => ownedOrigin(value, "worker-version-routing-target", "example")).toThrow();
		}
	});
});

describe("target worker", () => {
	const targetEnv: TargetEnv = {
		LAB_ID: "",
		CF_VERSION_METADATA: {
			id: "22222222-2222-4222-8222-222222222222",
			tag: "",
			timestamp: "2026-09-25T00:00:00.000Z",
		},
		RELEASE: "production",
		ENVIRONMENT: "production",
		PREVIEW_KEY: "",
		RESPONSE_VARIANT: "standard",
		WORKER_NAME: "worker-version-routing-target",
		CALLER_ORIGIN: "https://worker-version-routing-caller.example.workers.dev",
		WORKERS_DEV_SUBDOMAIN: "example",
	};

	it("identifies the exact target version", async () => {
		const response = await target.fetch(new IncomingRequest("https://target.example/health"), targetEnv);
		const body = await response.json<{ release: string; versionId: string }>();
		expect(response.status).toBe(200);
		expect(body.release).toBe("production");
		expect(body.versionId).toBe(targetEnv.CF_VERSION_METADATA.id);
	});

	it("serves the target interface regardless of local deployment state", async () => {
		const response = await target.fetch(new IncomingRequest("https://target.example/"), targetEnv);
		const html = await response.text();
		expect(response.status).toBe(200);
		expect(html).toContain(targetEnv.CALLER_ORIGIN);
	});

	it("renders setup and populated states from explicit manifests", () => {
		const base = {
			worker: targetEnv.WORKER_NAME,
			version: targetEnv.CF_VERSION_METADATA.id,
			targetOrigin: "https://target.example",
			callerOrigin: targetEnv.CALLER_ORIGIN,
			workersDevSubdomain: targetEnv.WORKERS_DEV_SUBDOMAIN,
			previews: [],
			checks: [],
			environment: "production",
			previewKey: "",
		};
		expect(renderPage({ ...base, candidateVersionId: "", labVersions: [] })).toContain("Run the bootstrap command");
		expect(renderPage({
			...base,
			candidateVersionId: "33333333-3333-4333-8333-333333333333",
			labVersions: [{ release: "lab-01", id: "44444444-4444-4444-8444-444444444444" }],
		})).toContain("lab-01");
		const populated = renderPage({ ...base, candidateVersionId: fixture.candidateVersionId, labVersions: fixture.labVersions, previews: fixture.previews });
		expect(populated).toContain(fixture.previews[0].revisions[0].target.url);
		expect(populated).toContain(fixture.previews[0].revisions[0].caller.versionId);
		expect(populated).toContain('data-query="deployment=pinned"');
		const pending: DeploymentManifest = structuredClone(fixture);
		pending.previews[0].revisions[1].caller!.verified = false;
		const pendingPage = renderPage({ ...base, candidateVersionId: "", labVersions: [], previews: pending.previews });
		expect(pendingPage).not.toContain('data-query="preview=branch-ui"');
		expect(pendingPage).not.toContain('data-query="deployment=pinned"');
	});
});
