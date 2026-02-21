import { config } from "dotenv";
import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const currentDir = dirname(fileURLToPath(import.meta.url));

const candidateEnvPaths = [
  resolve(process.cwd(), ".env"),
  resolve(currentDir, "../.env"),
  resolve(currentDir, "../../../.env"),
];

const selectedEnvPath = candidateEnvPaths.find((envPath) => existsSync(envPath));

if (selectedEnvPath) {
  config({ path: selectedEnvPath });
} else {
  config();
}
