import { parseArgs } from "node:util";
import { recoverPreviewReceipt } from "./previews.mjs";
const { values } = parseArgs({ options: {
	help: { type: "boolean" }, force: { type: "boolean" }, name: { type: "string" }, revision: { type: "string" }, variant: { type: "string" },
	"target-preview-id": { type: "string" }, "target-deployment-id": { type: "string" },
	"caller-preview-id": { type: "string" }, "caller-deployment-id": { type: "string" },
}, strict: true, allowPositionals: false });
if (values.help) console.log("Usage: npm run preview:recover -- --name branch-feature --revision r1 --variant compact --target-preview-id <id> --target-deployment-id <id> --force [--caller-preview-id <id> --caller-deployment-id <id>]");
else {
	if (!values.force || !values["target-preview-id"] || !values["target-deployment-id"]) throw new Error("Explicitly supply the known Preview/deployment IDs and --force to recover an unrecorded deployment.");
	await recoverPreviewReceipt({ name: values.name, revision: values.revision, variant: values.variant,
		targetPreviewId: values["target-preview-id"], targetDeploymentId: values["target-deployment-id"],
		callerPreviewId: values["caller-preview-id"], callerDeploymentId: values["caller-deployment-id"],
	});
}
