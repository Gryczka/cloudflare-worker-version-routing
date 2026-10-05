import { parseArgs } from "node:util";
import { cleanupPreview } from "./previews.mjs";
const { values } = parseArgs({ options: {
	help: { type: "boolean" }, name: { type: "string" }, force: { type: "boolean" },
}, strict: true, allowPositionals: false });
if (values.help) console.log("Usage: npm run preview:delete -- --name branch-feature --force (removes both Previews and all their deployments)");
else {
	if (!values.force || !values.name) throw new Error("Supply --name and --force to delete the recorded Preview pair and all its history.");
	await cleanupPreview(values.name);
}
