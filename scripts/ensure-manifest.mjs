/** Creates the ignored local manifest from its checked-in empty template. */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateManifest } from "./manifest.mjs";

const generated = fileURLToPath(new URL("../workers/target/src/versions.generated.json", import.meta.url));
const example = fileURLToPath(new URL("../workers/target/src/versions.example.json", import.meta.url));
if (!existsSync(generated)) copyFileSync(example, generated);
const current = JSON.parse(readFileSync(generated, "utf8"));
const upgraded = validateManifest(current, { allowEmpty: true });
if (current.schemaVersion !== 2) writeFileSync(generated, `${JSON.stringify(upgraded, null, "\t")}\n`, { mode: 0o600 });
