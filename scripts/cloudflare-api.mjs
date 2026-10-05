/** Read-only ownership lookups. Deployments and deletions still go through Wrangler. */
import { execFileSync } from "node:child_process";
import { PROJECT_ROOT, WRANGLER } from "./wrangler.mjs";

let authentication;
function authHeaders() {
	if (process.env.CLOUDFLARE_API_TOKEN) return { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` };
	if (!authentication) {
		const env = { ...process.env, WRANGLER_WRITE_LOGS: "false", WRANGLER_LOG: "log", WRANGLER_SEND_METRICS: "false", WRANGLER_SEND_ERROR_REPORTS: "false" };
		delete env.WRANGLER_OUTPUT_FILE_PATH;
		delete env.WRANGLER_OUTPUT_FILE_DIRECTORY;
		try {
			// auth token normally logs its JSON. Capture it privately and disable disk logging.
			const output = execFileSync(process.execPath, [WRANGLER, "auth", "token", "--json"], {
				cwd: PROJECT_ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
			});
			authentication = JSON.parse(output);
		} catch { throw new Error("Could not obtain authenticated, read-only ownership lookups through Wrangler."); }
	}
	if (["api_token", "oauth"].includes(authentication.type) && typeof authentication.token === "string") return { authorization: `Bearer ${authentication.token}` };
	if (authentication.type === "api_key" && authentication.key && authentication.email) return { "x-auth-key": authentication.key, "x-auth-email": authentication.email };
	throw new Error("Wrangler returned an unsupported authentication method.");
}

export async function accountGet(accountId, path, { missing = false } = {}) {
	if (!/^[0-9a-f]{32}$/.test(accountId) || !path.startsWith("workers/") || path.includes("..")) throw new Error("Invalid ownership lookup path.");
	const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/${path}`, {
		headers: authHeaders(), redirect: "error", signal: AbortSignal.timeout(20_000),
	});
	const data = await response.json();
	if (missing && response.status === 404 && data.success === false && Array.isArray(data.errors)) return null;
	if (!response.ok || data.success !== true) {
		const codes = data.errors?.map(({ code }) => code).join(", ") ?? "unknown";
		throw new Error(`Ownership lookup failed (HTTP ${response.status}, codes ${codes}). No resource mutation was authorized.`);
	}
	return data.result;
}

export async function accountSubdomain(accountId) {
	const result = await accountGet(accountId, "workers/subdomain");
	if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(result?.subdomain ?? "")) throw new Error("Configure a workers.dev subdomain before creating this lab.");
	return result.subdomain;
}

export function getNamedPreview(accountId, worker, identifier) {
	return accountGet(accountId, `workers/workers/${encodeURIComponent(worker)}/previews/${encodeURIComponent(identifier)}`, { missing: true });
}

export function getPreviewDeployment(accountId, worker, identifier, deploymentId) {
	return accountGet(accountId, `workers/workers/${encodeURIComponent(worker)}/previews/${encodeURIComponent(identifier)}/deployments/${encodeURIComponent(deploymentId)}`);
}
