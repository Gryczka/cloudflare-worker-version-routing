import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../workers/caller/src/index";
import target from "../workers/target/src/index";
import { renderPage } from "../workers/target/src/ui";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

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

describe("target worker", () => {
	const targetEnv: TargetEnv = {
		CF_VERSION_METADATA: {
			id: "22222222-2222-4222-8222-222222222222",
			tag: "",
			timestamp: "2026-09-25T00:00:00.000Z",
		},
		RELEASE: "production",
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
		};
		expect(renderPage({ ...base, candidateVersionId: "", labVersions: [] })).toContain("Run the bootstrap command");
		expect(renderPage({
			...base,
			candidateVersionId: "33333333-3333-4333-8333-333333333333",
			labVersions: [{ release: "lab-01", id: "44444444-4444-4444-8444-444444444444" }],
		})).toContain("lab-01");
	});
});
