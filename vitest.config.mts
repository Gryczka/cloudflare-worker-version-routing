import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./workers/caller/wrangler.jsonc" },
			miniflare: {
				serviceBindings: {
					TARGET: async (request: Request) => {
						const override = request.headers.get("Cloudflare-Workers-Version-Overrides") ?? "";
						const versionId = override.match(/="([0-9a-f-]{36})"/)?.[1] ?? "missing";
						if (versionId.startsWith("ffffffff")) return new Response("x".repeat(65_537));
						return Response.json({
							ok: true,
							worker: "worker-version-routing-target",
							release: "candidate",
							versionId,
							hostname: new URL(request.url).hostname,
							path: new URL(request.url).pathname,
						});
					},
				},
			},
		}),
	],
	test: {
		include: ["test/**/*.spec.ts"],
	},
});
