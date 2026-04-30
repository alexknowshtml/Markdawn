import { setupLogger, getWebLogger } from "@markdawn/shared";

let initialized = false;

export async function initLogger(): Promise<void> {
  if (initialized) {
    return;
  }
  await setupLogger();
  initialized = true;
}

export function getLogger() {
  return getWebLogger();
}