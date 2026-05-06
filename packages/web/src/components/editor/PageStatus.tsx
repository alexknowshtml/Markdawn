import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { WebSocketStatus } from '@hocuspocus/provider';
import React from 'react';
import { CollabStatus } from './CollabStatus';

interface PageStatusProps {
  provider: HocuspocusProvider | null;
  collabStatus: WebSocketStatus;
}

export function PageStatus({ provider, collabStatus }: PageStatusProps) {
  return <CollabStatus provider={provider} status={collabStatus} />;
}
