/** Bundle production and a local projection of Preview settings. Never invokes `wrangler preview`. */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { PROJECT_ROOT, TARGET_CONFIG, CALLER_CONFIG, runWrangler } from "./wrangler.mjs";

export function projectPreviewConfig(config) {
	if (!config.previews) throw new Error("Missing previews configuration.");
	const keys = ["name", "main", "compatibility_date", "compatibility_flags", "upload_source_maps", "assets", "migrations", "observability", "limits", "placement"];
	const code = Object.fromEntries(keys.filter((key) => key in config).map((key) => [key, config[key]]));
	return { ...code, ...config.previews, workers_dev: false, preview_urls: false, routes: [] };
}

export function checkBundles({ production = true, run = runWrangler } = {}) {
	for (const configPath of [TARGET_CONFIG, CALLER_CONFIG]) {
		if (production) run(["deploy", "--dry-run", "--config", configPath]);
		const config = JSON.parse(readFileSync(resolve(PROJECT_ROOT, configPath), "utf8"));
		const temporary = resolve(PROJECT_ROOT, dirname(configPath), "wrangler.preview-check.generated.json");
		try {
			writeFileSync(temporary, `${JSON.stringify(projectPreviewConfig(config), null, "\t")}\n`, { mode: 0o600 });
			run(["deploy", "--dry-run", "--config", `${dirname(configPath)}/${basename(temporary)}`]);
		} finally { rmSync(temporary, { force: true }); }
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const { values } = parseArgs({ options: { help: { type: "boolean" } }, strict: true, allowPositionals: false });
	if (values.help) console.log("Usage: npm run deploy:dry-run (bundles production and projected Preview settings; no cloud deployment)");
	else checkBundles();
}
