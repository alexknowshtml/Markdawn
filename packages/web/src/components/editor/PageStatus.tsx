import React from "react";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { WebSocketStatus } from "@hocuspocus/provider";
import { CollabStatus } from "./CollabStatus";

interface PageStatusProps {
  provider: HocuspocusProvider | null;
  collabStatus: WebSocketStatus;
}

export function PageStatus({ provider, collabStatus }: PageStatusProps) {
  return <CollabStatus provider={provider} status={collabStatus} />;
}