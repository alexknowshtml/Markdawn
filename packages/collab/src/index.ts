import { Database } from "@hocuspocus/extension-database";
import { Server } from "@hocuspocus/server";
import type { onConnectPayload, onDisconnectPayload } from "@hocuspocus/server";

const port = Number(process.env.COLLAB_PORT ?? "1234");

const inMemoryStore = new Map<string, Uint8Array>();

const server = new Server({
  port,
  onAuthenticate: async () => true,
  onConnect: async ({ documentName, socketId }: onConnectPayload) => {
    console.info("collab connection", { documentName, socketId });
  },
  onDisconnect: async ({ documentName, socketId }: onDisconnectPayload) => {
    console.info("collab disconnection", { documentName, socketId });
  },
  extensions: [
    new Database({
      fetch: async ({ documentName }) => inMemoryStore.get(documentName) ?? null,
      store: async ({ documentName, state }) => {
        inMemoryStore.set(documentName, state);
      },
    }),
  ],
});

server.listen();
