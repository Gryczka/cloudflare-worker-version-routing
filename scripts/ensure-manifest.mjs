/** Creates the ignored local manifest from its checked-in empty template. */
import { copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const generated = fileURLToPath(new URL("../workers/target/src/versions.generated.json", import.meta.url));
const example = fileURLToPath(new URL("../workers/target/src/versions.example.json", import.meta.url));
if (!existsSync(generated)) copyFileSync(example, generated);
