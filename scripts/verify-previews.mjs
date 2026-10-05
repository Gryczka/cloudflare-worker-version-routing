import { parseArgs } from "node:util";
import { verifyPreviewHistory } from "./previews.mjs";
const { values } = parseArgs({ options: { help: { type: "boolean" } }, strict: true, allowPositionals: false });
if (values.help) console.log("Usage: npm run preview:verify (checks recorded stable/fixed URLs and both-hop pinning)");
else console.log(JSON.stringify(await verifyPreviewHistory(), null, 2));
