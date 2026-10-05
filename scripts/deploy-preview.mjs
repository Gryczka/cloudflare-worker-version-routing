import { parseArgs } from "node:util";
import { checkBundles } from "./check-previews.mjs";
import { deployPreviewPair } from "./previews.mjs";
import { PREVIEW_KEY, REVISION } from "./manifest.mjs";

const { values } = parseArgs({ options: {
	help: { type: "boolean" }, name: { type: "string" }, revision: { type: "string" },
	variant: { type: "string", default: "compact" }, "dry-run": { type: "boolean" },
}, strict: true, allowPositionals: false });
if (values.help) {
	console.log("Usage: npm run preview:pair -- --name branch-feature --revision r1 [--variant compact|detailed] [--dry-run]");
} else {
	if (!PREVIEW_KEY.test(values.name ?? "") || !REVISION.test(values.revision ?? "")) throw new Error("Supply a valid --name branch-feature and --revision r1.");
	if (!["compact", "detailed"].includes(values.variant)) throw new Error("Choose compact or detailed.");
	if (values["dry-run"]) {
		checkBundles({ production: false });
		console.log("Validated Preview bundles only. A real run deploys target first, captures fixed/stable URLs, then deploys caller. No Preview was created.");
	} else await deployPreviewPair({ name: values.name, revision: values.revision, variant: values.variant });
}
