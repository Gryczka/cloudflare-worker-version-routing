/** Deployment receipts are captured by Wrangler; runtime version IDs come from /health. */
export interface PreviewResource {
	id: string;
	name: string;
	slug: string;
	url: string;
	urls: string[];
}

export interface PreviewDeployment {
	id: string;
	url: string;
	urls: string[];
	versionId: string;
	release: string;
	timestamp: string;
	verified?: boolean;
}

export interface PreviewRevision {
	key: string;
	release: string;
	variant: string;
	productionBeforeVersionId?: string;
	target: PreviewDeployment;
	caller: PreviewDeployment | null;
}

export interface PreviewBranch {
	key: string;
	target: PreviewResource;
	caller: PreviewResource | null;
	revisions: PreviewRevision[];
	deletion?: { caller: boolean; target: boolean };
}

export interface VersionEntry {
	release: string;
	id: string;
}

export interface VerificationCheck {
	name: string;
	passed: boolean;
	at: string;
	callerVersionId?: string;
	targetVersionId?: string;
}

export interface DeploymentManifest {
	schemaVersion: number;
	accountId: string;
	labId?: string;
	workersDevSubdomain: string;
	uiOrigins: string[];
	candidateVersionId: string;
	productionVersionId: string;
	callerVersionId: string;
	labVersions: VersionEntry[];
	previews: PreviewBranch[];
	checks: VerificationCheck[];
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const KEY = /^[a-z][a-z0-9-]{0,39}$/;
export const ALIAS = /^[a-z][a-z0-9-]{0,31}$/;

/** Public HTTP destinations must be root origins belonging to the configured Worker. */
export function ownedOrigin(value: string, worker: string, subdomain: string): string {
	const url = new URL(value);
	const suffix = `${worker}.${subdomain}.workers.dev`;
	const prefix = url.hostname.endsWith(`-${suffix}`) ? url.hostname.slice(0, -(suffix.length + 1)) : "";
	if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
		url.pathname !== "/" || !(url.hostname === suffix || /^[a-z0-9][a-z0-9-]{0,62}$/.test(prefix)) ||
		url.hostname.split(".").some((label) => label.length > 63)) {
		throw new Error("Destination is not a captured, target-owned workers.dev origin.");
	}
	return url.origin;
}

export function findRevision(branches: PreviewBranch[], key: string): PreviewRevision | undefined {
	for (const branch of branches) {
		const revision = branch.revisions.find((entry) => entry.key === key);
		if (revision) return revision;
	}
	return undefined;
}

/** Pending or deleting pairs cannot advertise verified routing guarantees. */
export function verifiedPreviewBranches(branches: PreviewBranch[]): PreviewBranch[] {
	return branches.filter((branch) => !branch.deletion && branch.revisions.length > 0 &&
		branch.revisions.every((entry) => entry.target.verified !== false && entry.caller && entry.caller.verified !== false));
}
