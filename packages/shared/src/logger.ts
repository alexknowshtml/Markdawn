import { configure, getConsoleSink, getLogger, type Logger } from "@logtape/logtape";

let isConfigured = false;

export async function setupLogger(): Promise<void> {
  if (isConfigured) {
    return;
  }

  const isProduction = process.env.NODE_ENV === "production";

  await configure({
    sinks: {
      console: getConsoleSink(),
    },
    loggers: [
      { category: ["markdawn", "api"], lowestLevel: "info", sinks: ["console"] },
      { category: ["markdawn", "http"], lowestLevel: "debug", sinks: ["console"] },
      { category: ["markdawn", "db"], lowestLevel: "debug", sinks: ["console"] },
      { category: ["markdawn", "auth"], lowestLevel: "info", sinks: ["console"] },
      { category: ["markdawn", "collab"], lowestLevel: "info", sinks: ["console"] },
      { category: ["markdawn", "web"], lowestLevel: "debug", sinks: ["console"] },
      { category: ["markdawn"], lowestLevel: "info", sinks: ["console"] },
    ],
  });

  isConfigured = true;
}

export function getApiLogger(): Logger {
  return getLogger(["markdawn", "api"]);
}

export function getDbLogger(): Logger {
  return getLogger(["markdawn", "db"]);
}

export function getAuthLogger(): Logger {
  return getLogger(["markdawn", "auth"]);
}

export function getCollabLogger(): Logger {
  return getLogger(["markdawn", "collab"]);
}

export function getWebLogger(): Logger {
  return getLogger(["markdawn", "web"]);
}

export function getAppLogger(): Logger {
  return getLogger(["markdawn"]);
}