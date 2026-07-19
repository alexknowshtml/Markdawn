import type { Hocuspocus } from '@hocuspocus/server';
import { Connection, type Document, MessageReceiver, Server } from '@hocuspocus/server';
import type { Logger } from '@logtape/logtape';
import {
  COLLAB_TERMINAL_REASONS,
  DEFAULT_MAX_COLLAB_PAYLOAD_BYTES,
  getAnimalEmoji,
  getAnonymousName,
  getStableColor,
  getUnicodeCodePointLength,
  MAX_PAGE_TITLE_LENGTH,
  MAX_YDOC_BYTES,
  type PermissionSnapshotMessage,
  type ShareEventPayload,
  type SharePermission,
  type StatelessShareMessage,
  shouldApplyPermissionSnapshot,
} from '@markdawn/shared';
import {
  type ConnectionDraft,
  extractConnectionsFromYDoc,
  normalizeTagSlug,
  stripWikiLinkTargetIds,
} from '@markdawn/shared/yjs-helpers';
import { Client, type Pool, type PoolClient, type QueryResult } from 'pg';
import * as Y from 'yjs';
import { createCoalescingTaskQueue } from './coalescingTaskQueue';
import {
  handleShareEvent,
  handleWorkspaceEvent,
  revalidateActivePageConnections,
  type WorkspaceEventPayload,
} from './permission-handler';
import { parseCookies } from './utils';

const META_ROOM_PREFIX = 'page-meta:';
const DELETION_EVENT_QUEUE_LIMIT = 256;
const GRANT_EVENT_QUEUE_LIMIT = 256;
const PAGE_RENAME_EVENT_QUEUE_LIMIT = 256;
const SHARE_EVENT_QUEUE_LIMIT = 256;
const WORKSPACE_EVENT_QUEUE_LIMIT = 256;
const AWARENESS_RELAY_FINGERPRINT_LIMIT = 256;
const APPLICATION_FENCE_TIMEOUT_MS = 10_000;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INITIAL_AWARENESS_SENDER = Symbol.for('markdawn.initialAwarenessSender');
const CONNECTION_OUTBOUND_SENDER = Symbol.for('markdawn.connectionOutboundSender');
const CONNECTION_CLOSE_HANDLER = Symbol.for('markdawn.connectionCloseHandler');
const MESSAGE_RECEIVER_APPLIER = Symbol.for('markdawn.messageReceiverApplier');
const canonicalTitlesByServer = new WeakMap<Hocuspocus, Map<string, string>>();
const acceptedTitlesByServer = new WeakMap<Hocuspocus, Map<string, string>>();
const pendingTitleBaselinesByServer = new WeakMap<Hocuspocus, Map<string, string>>();

type WriteAdmission = {
  accessRevision: string;
  titleRevision: string;
  touchesTitle: boolean;
};

type WriteAdmissionContext = DeferredAwarenessContext & {
  pendingWriteAdmissions?: WriteAdmission[];
};

type ApplicationFence = {
  admission: WriteAdmission;
  context: WriteAdmissionContext;
  complete(applied: boolean, changed?: boolean): Promise<void>;
};

const applicationFencesByMessage = new WeakMap<Uint8Array, ApplicationFence>();
const expiredApplicationMessages = new WeakSet<Uint8Array>();
const relayedAwarenessMessages = new WeakSet<Uint8Array>();
const writeAdmissionsByUpdate = new WeakMap<Uint8Array, WriteAdmission>();

type EstablishmentGate = {
  state: 'pending' | 'established' | 'rejected';
  ready: Promise<boolean>;
  settle(allowed: boolean): void;
};
type DeferredAwarenessContext = {
  deferInitialAwareness?: boolean;
  establishmentGate?: EstablishmentGate;
  applicationsInFlight?: number;
  applicationCheck?: Promise<void>;
  resolveApplicationCheck?: () => void;
  pendingCloseEvent?: { code?: number; reason?: string };
  closeAfterApplicationScheduled?: boolean;
  sentAwarenessRelayFingerprints?: Set<string>;
};
type AwarenessConnectionLike = {
  context?: DeferredAwarenessContext;
  document?: { hasConnection(connection: AwarenessConnectionLike): boolean };
};
type InitialAwarenessSender = (this: AwarenessConnectionLike) => void;
type ConnectionOutboundSender = (this: AwarenessConnectionLike, message: unknown) => void;
type ConnectionCloseHandler = (
  this: AwarenessConnectionLike,
  event?: { code?: number; reason?: string },
) => void;
type AwarenessConnectionPrototype = {
  close: ConnectionCloseHandler;
  handleMessage(data: Uint8Array): void;
  sendCurrentAwareness: InitialAwarenessSender;
  send: ConnectionOutboundSender;
  [CONNECTION_CLOSE_HANDLER]?: ConnectionCloseHandler;
  [INITIAL_AWARENESS_SENDER]?: InitialAwarenessSender;
  [CONNECTION_OUTBOUND_SENDER]?: ConnectionOutboundSender;
};

type MessageReceiverPrototype = {
  apply: MessageReceiver['apply'];
  [MESSAGE_RECEIVER_APPLIER]?: MessageReceiver['apply'];
};

const awarenessConnectionPrototype =
  Connection.prototype as unknown as AwarenessConnectionPrototype;
if (!awarenessConnectionPrototype[INITIAL_AWARENESS_SENDER]) {
  const originalSender = awarenessConnectionPrototype.sendCurrentAwareness;
  awarenessConnectionPrototype[INITIAL_AWARENESS_SENDER] = originalSender;
  awarenessConnectionPrototype.sendCurrentAwareness = function sendCurrentAwarenessAfterAccess() {
    const context = this.context as DeferredAwarenessContext | undefined;
    if (context?.deferInitialAwareness === true) return;
    originalSender.call(this);
  };
}

// Hocuspocus registers a Connection on the shared Document before its
// `connected` hook runs. Quarantine all document-originated traffic during that
// gap: another editor can otherwise broadcast content, awareness, or stateless
// messages to a connection whose access was revoked after authentication.
if (!awarenessConnectionPrototype[CONNECTION_OUTBOUND_SENDER]) {
  const originalSender = awarenessConnectionPrototype.send;
  awarenessConnectionPrototype[CONNECTION_OUTBOUND_SENDER] = originalSender;
  awarenessConnectionPrototype.send = function sendAfterAccessEstablishment(message) {
    const context = this.context as DeferredAwarenessContext | undefined;
    const gate = context?.establishmentGate;
    if (gate?.state === 'pending' || (!gate && context?.deferInitialAwareness === true)) return;
    if (gate?.state === 'rejected' && this.document?.hasConnection(this) === true) return;
    if (context) rememberOutboundAwarenessEntries(context, message);
    originalSender.call(this, message);
  };
}

// Every close path (expiry, deletion, share events, protocol denial, socket
// shutdown) must atomically defeat a pending establishment. An admitted write,
// however, owns the workspace/page transaction until MessageReceiver physically
// applies it. Defer the destructive part of close until that application fence
// finishes so revoke/Trash teardown cannot destroy the document in the gap.
if (!awarenessConnectionPrototype[CONNECTION_CLOSE_HANDLER]) {
  const originalClose = awarenessConnectionPrototype.close;
  awarenessConnectionPrototype[CONNECTION_CLOSE_HANDLER] = originalClose;
  awarenessConnectionPrototype.close = function closeAndRejectTraffic(event) {
    const context = this.context as DeferredAwarenessContext | undefined;
    if (context) rejectConnectionTraffic(context);
    if (context && (context.applicationsInFlight ?? 0) > 0 && context.applicationCheck) {
      if (event === undefined) delete context.pendingCloseEvent;
      else context.pendingCloseEvent = event;
      if (!context.closeAfterApplicationScheduled) {
        context.closeAfterApplicationScheduled = true;
        void context.applicationCheck.finally(() => {
          context.closeAfterApplicationScheduled = false;
          const pendingEvent = context.pendingCloseEvent;
          delete context.pendingCloseEvent;
          originalClose.call(this, pendingEvent);
        });
      }
      return;
    }
    originalClose.call(this, event);
  };
}

function removePendingWriteAdmission(
  context: WriteAdmissionContext,
  admission: WriteAdmission,
): void {
  const pending = context.pendingWriteAdmissions;
  if (!pending) return;
  const index = pending.indexOf(admission);
  if (index >= 0) pending.splice(index, 1);
  if (pending.length === 0) delete context.pendingWriteAdmissions;
}

// Hocuspocus resolves beforeHandleMessage and applies the message in a later
// promise continuation. Its hook API has no "after physical apply" hook, so
// bridge that exact gap at MessageReceiver. The fence is keyed by the raw
// Uint8Array passed to beforeHandleMessage; the decoder retains that same
// object. We also capture the exact inner Yjs update emitted by this apply so
// onChange never attributes a title mutation to another connection's update.
const messageReceiverPrototype = MessageReceiver.prototype as MessageReceiverPrototype;
if (!messageReceiverPrototype[MESSAGE_RECEIVER_APPLIER]) {
  const originalApply = messageReceiverPrototype.apply;
  messageReceiverPrototype[MESSAGE_RECEIVER_APPLIER] = originalApply;
  messageReceiverPrototype.apply = function applyWithApplicationFence(
    this: MessageReceiver,
    document: Document,
    connection?: Connection,
    reply?: (message: Uint8Array) => void,
  ): ReturnType<MessageReceiver['apply']> {
    const rawMessage = this.message.decoder.arr;
    if (relayedAwarenessMessages.has(rawMessage)) {
      relayedAwarenessMessages.delete(rawMessage);
      return undefined;
    }
    if (expiredApplicationMessages.has(rawMessage)) {
      expiredApplicationMessages.delete(rawMessage);
      throw new Error('Write application fence expired');
    }
    const fence = applicationFencesByMessage.get(rawMessage);
    if (!fence) return originalApply.call(this, document, connection, reply);

    let capturedUpdate: Uint8Array | undefined;
    const captureAppliedUpdate = (innerUpdate: Uint8Array, origin: unknown) => {
      if (capturedUpdate || origin !== connection) return;
      capturedUpdate = innerUpdate;
      writeAdmissionsByUpdate.set(innerUpdate, fence.admission);
      removePendingWriteAdmission(fence.context, fence.admission);
    };
    document.on('update', captureAppliedUpdate);
    try {
      const result = originalApply.call(this, document, connection, reply);
      // A duplicate/no-op update emits no Yjs update event and therefore has no
      // onChange lifecycle to consume its admission marker.
      if (!capturedUpdate) removePendingWriteAdmission(fence.context, fence.admission);
      void fence.complete(true, capturedUpdate !== undefined).catch(() => {
        connection?.close({ code: 4500, reason: 'Write application commit failed' });
      });
      return result;
    } catch (error) {
      if (capturedUpdate) writeAdmissionsByUpdate.delete(capturedUpdate);
      removePendingWriteAdmission(fence.context, fence.admission);
      void fence.complete(false);
      throw error;
    } finally {
      document.off('update', captureAppliedUpdate);
    }
  };
}

function createEstablishmentGate(): EstablishmentGate {
  let resolveReady: ((allowed: boolean) => void) | undefined;
  const gate: EstablishmentGate = {
    state: 'pending',
    ready: new Promise<boolean>((resolve) => {
      resolveReady = resolve;
    }),
    settle(allowed) {
      if (gate.state !== 'pending') return;
      gate.state = allowed ? 'established' : 'rejected';
      resolveReady?.(allowed);
    },
  };
  return gate;
}

function releaseConnectionTraffic(context: DeferredAwarenessContext): boolean {
  const gate = context.establishmentGate;
  if (gate?.state === 'rejected') return false;
  if (gate) gate.settle(true);
  else {
    const establishedGate = createEstablishmentGate();
    establishedGate.settle(true);
    context.establishmentGate = establishedGate;
  }
  return true;
}

function rejectConnectionTraffic(context: DeferredAwarenessContext): void {
  const gate = context.establishmentGate;
  if (gate) {
    if (gate.state === 'pending') gate.settle(false);
    else gate.state = 'rejected';
  } else {
    const rejectedGate = createEstablishmentGate();
    rejectedGate.settle(false);
    context.establishmentGate = rejectedGate;
  }
  delete context.deferInitialAwareness;
}

async function waitForConnectionTraffic(
  context: DeferredAwarenessContext,
  connection: unknown,
): Promise<boolean> {
  const gate = context.establishmentGate;
  if (!gate) return true;
  if (gate.state === 'rejected') return false;
  // Direct hook tests use lightweight connection doubles. Real network traffic
  // always arrives through Hocuspocus' Connection instance and must wait for
  // the post-authentication establishment fence.
  if (!(connection instanceof Connection)) return true;
  const allowed = await gate.ready;
  return allowed && gate.state === 'established';
}

function sendDeferredInitialAwareness(connection: Connection): void {
  const context = connection.context as DeferredAwarenessContext | undefined;
  if (context?.deferInitialAwareness !== true) return;
  delete context.deferInitialAwareness;
  awarenessConnectionPrototype[INITIAL_AWARENESS_SENDER]?.call(
    connection as unknown as AwarenessConnectionLike,
  );
}

export function getShareEventQueueKey(payload: ShareEventPayload): string {
  return JSON.stringify([
    payload.entityType,
    payload.entityId,
    payload.targetUserId ?? null,
    payload.metaOnly === true ? 'meta' : 'permission',
  ]);
}

export function mergeShareEventMetadata(
  existing: ShareEventPayload,
  incoming: ShareEventPayload,
): ShareEventPayload {
  const metaUserIds = [
    ...new Set([...(existing.metaUserIds ?? []), ...(incoming.metaUserIds ?? [])]),
  ];
  return {
    ...incoming,
    ...(metaUserIds.length > 0 ? { metaUserIds } : {}),
  };
}

type EffectivePermission = Extract<SharePermission, 'view' | 'edit' | 'admin'>;

type PermissionSnapshotConnection = {
  sendStateless(payload: string): void;
};

function sendPermissionSnapshot(
  connection: PermissionSnapshotConnection,
  permission: EffectivePermission | null,
  accessRevision: string,
): void {
  connection.sendStateless(
    JSON.stringify({
      type: 'permission_snapshot',
      permission,
      accessRevision,
    } satisfies PermissionSnapshotMessage),
  );
}

function readVarUint(input: Uint8Array, initialOffset: number): { value: number; offset: number } {
  let value = 0;
  let multiplier = 1;
  let offset = initialOffset;
  while (offset < input.length) {
    const byte = input[offset];
    if (byte === undefined) break;
    value += (byte & 0x7f) * multiplier;
    offset += 1;
    if (byte < 0x80) return { value, offset };
    multiplier *= 128;
    if (!Number.isSafeInteger(value) || multiplier > Number.MAX_SAFE_INTEGER) break;
  }
  throw new Error('Malformed collaboration message');
}

/** Extract the Yjs update from messages that can mutate the server document. */
function getYjsWriteUpdate(update: Uint8Array): Uint8Array | null {
  try {
    const documentNameLength = readVarUint(update, 0);
    const messageType = readVarUint(update, documentNameLength.offset + documentNameLength.value);
    // Hocuspocus MessageType.Sync = 0 and MessageType.SyncReply = 4.
    if (messageType.value !== 0 && messageType.value !== 4) return null;
    const syncType = readVarUint(update, messageType.offset);
    // y-protocols SyncStep2 = 1 and Update = 2. Both may contain new structs.
    if (syncType.value !== 1 && syncType.value !== 2) return null;
    const payloadLength = readVarUint(update, syncType.offset);
    const payloadEnd = payloadLength.offset + payloadLength.value;
    if (payloadEnd > update.length) throw new Error('Malformed collaboration message');
    const payload = update.slice(payloadLength.offset, payloadEnd);
    try {
      const decoded = Y.decodeUpdate(payload);
      if (decoded.structs.length === 0 && decoded.ds.clients.size === 0) return null;
    } catch {
      // Malformed Yjs payloads are potential writes. A view-only actor is
      // rejected here; an editor proceeds to the protocol decoder, which
      // closes only that actor without touching the shared document.
    }
    return payload;
  } catch {
    // The protocol decoder will reject malformed input after this hook. It is
    // not treated as a write because no document mutation can occur first.
    return null;
  }
}

type DecodedYjsUpdate = ReturnType<typeof Y.decodeUpdate>;

function findStructContainingClock(
  structs: readonly Y.AbstractStruct[] | undefined,
  clock: number,
): Y.AbstractStruct | undefined {
  return structs?.find(
    (struct) => clock >= struct.id.clock && clock < struct.id.clock + struct.length,
  );
}

/**
 * Determine whether this specific Yjs update targets the root `title` type.
 * Looking only at the document title before/after apply is not sufficient: a
 * content-only update from connection B may physically apply after connection
 * A changes the global title, and would then be falsely credited with A's
 * rename. Struct ancestry and delete ranges preserve per-update attribution,
 * including continuation inserts whose decoded parent is inherited from an
 * origin item.
 */
export function yjsUpdateTouchesTitle(document: Y.Doc, update: Uint8Array): boolean {
  let decoded: DecodedYjsUpdate;
  try {
    decoded = Y.decodeUpdate(update);
  } catch {
    // Malformed payloads are fenced conservatively. MessageReceiver will reject
    // them and the application finalizer rolls the transaction back.
    return true;
  }

  const title = document.getText('title');
  const decodedByClient = new Map<number, Y.AbstractStruct[]>();
  for (const struct of decoded.structs) {
    const clientStructs = decodedByClient.get(struct.id.client) ?? [];
    clientStructs.push(struct);
    decodedByClient.set(struct.id.client, clientStructs);
  }

  const resolveStruct = (id: Y.ID): Y.AbstractStruct | undefined =>
    findStructContainingClock(decodedByClient.get(id.client), id.clock) ??
    findStructContainingClock(document.store.clients.get(id.client), id.clock);
  const visited = new Set<Y.AbstractStruct>();
  const targetsTitle = (struct: Y.AbstractStruct | undefined): boolean => {
    if (!struct || !(struct instanceof Y.Item) || visited.has(struct)) return false;
    visited.add(struct);
    const parent = struct.parent as unknown;
    if (parent === 'title' || parent === title) return true;
    if (typeof parent === 'string') return false;
    if (parent instanceof Y.ID) {
      const parentStruct = resolveStruct(parent);
      return parentStruct ? targetsTitle(parentStruct) : true;
    }
    if (parent instanceof Y.AbstractType) return parent === title;

    // Differential updates omit a repeated parent and inherit it from their
    // left/right origin. Follow both because either can carry the root type.
    if (struct.origin) {
      const origin = resolveStruct(struct.origin);
      if (!origin || targetsTitle(origin)) return true;
    }
    if (struct.rightOrigin) {
      const rightOrigin = resolveStruct(struct.rightOrigin);
      if (!rightOrigin || targetsTitle(rightOrigin)) return true;
    }
    return false;
  };

  if (decoded.structs.some((struct) => targetsTitle(struct))) return true;

  for (const [clientId, deletions] of decoded.ds.clients) {
    const candidateStructs = [
      ...(document.store.clients.get(clientId) ?? []),
      ...(decodedByClient.get(clientId) ?? []),
    ];
    for (const deletion of deletions) {
      const deletionEnd = deletion.clock + deletion.len;
      let resolvedDeletion = false;
      for (const struct of candidateStructs) {
        const structEnd = struct.id.clock + struct.length;
        if (struct.id.clock >= deletionEnd || structEnd <= deletion.clock) continue;
        resolvedDeletion = true;
        if (targetsTitle(struct)) return true;
      }
      // A pending delete can become effective only after its missing target
      // arrives. Its root type is unknowable yet, so preserve title ordering
      // conservatively until integration resolves it.
      if (!resolvedDeletion) return true;
    }
  }
  return false;
}

/**
 * A page room has one canonical Y.Doc for every reader, so a target UUID in a
 * wiki-link attribute would disclose that target even to readers who cannot
 * enumerate it. Validate the semantic post-update document before Hocuspocus
 * physically applies or broadcasts the client update.
 */
export function yjsUpdateIntroducesWikiLinkTargetIds(
  _document: Y.Doc,
  update: Uint8Array,
): boolean {
  try {
    const decoded = Y.decodeUpdate(update);
    // XmlElement attributes are Y.Items whose parentSub is the attribute key,
    // including when the parent struct has not arrived yet. This raw check is
    // therefore complete for old/malicious wiki-link targetId attributes and
    // stays O(update), rather than cloning an up-to-16MB document per keystroke.
    return decoded.structs.some(
      (struct) =>
        struct instanceof Y.Item &&
        struct.parentSub === 'targetId' &&
        !(struct.content instanceof Y.ContentDeleted),
    );
  } catch {
    // The protocol decoder owns malformed-message rejection below.
    return false;
  }
}

export function sanitizeCanonicalYjsUpdate(update: Uint8Array): Uint8Array {
  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, update);
    if (candidate.store.pendingStructs !== null || candidate.store.pendingDs !== null) {
      throw new Error('Canonical Yjs state contains unresolved updates');
    }
    stripWikiLinkTargetIds(candidate);
    // Always re-encode. Even when no live attribute remains, an input update
    // can retain a UUID in tombstoned set/delete structs.
    const canonicalState = Y.encodeStateAsUpdate(candidate);
    const canonicalDecoded = Y.decodeUpdate(canonicalState);
    if (
      canonicalDecoded.structs.some(
        (struct) =>
          struct instanceof Y.Item &&
          struct.parentSub === 'targetId' &&
          !(struct.content instanceof Y.ContentDeleted),
      )
    ) {
      throw new Error('Canonical Yjs state contains forbidden wiki-link target metadata');
    }
    return canonicalState;
  } finally {
    candidate.destroy();
  }
}

function getProtocolMessageType(update: Uint8Array): number | null {
  try {
    const documentNameLength = readVarUint(update, 0);
    const messageType = readVarUint(update, documentNameLength.offset + documentNameLength.value);
    return messageType.value;
  } catch {
    return null;
  }
}

type ParsedAwarenessEntry = {
  clientId: number;
  clock: number;
  state: unknown;
};

function parseAwarenessEntries(update: Uint8Array): ParsedAwarenessEntry[] {
  const documentNameLength = readVarUint(update, 0);
  const messageType = readVarUint(update, documentNameLength.offset + documentNameLength.value);
  if (messageType.value !== 1) throw new Error('Not an awareness message');
  const payloadLength = readVarUint(update, messageType.offset);
  const payloadEnd = payloadLength.offset + payloadLength.value;
  if (payloadEnd !== update.length) throw new Error('Malformed awareness message');

  const entryCount = readVarUint(update, payloadLength.offset);
  const entries: ParsedAwarenessEntry[] = [];
  let offset = entryCount.offset;
  for (let index = 0; index < entryCount.value; index += 1) {
    const clientId = readVarUint(update, offset);
    const clock = readVarUint(update, clientId.offset);
    const stateLength = readVarUint(update, clock.offset);
    const stateEnd = stateLength.offset + stateLength.value;
    if (stateEnd > payloadEnd) throw new Error('Malformed awareness message');
    const stateJson = new TextDecoder('utf-8', { fatal: true }).decode(
      update.slice(stateLength.offset, stateEnd),
    );
    const state: unknown = JSON.parse(stateJson);
    entries.push({ clientId: clientId.value, clock: clock.value, state });
    offset = stateEnd;
  }
  if (offset !== payloadEnd) throw new Error('Malformed awareness message');
  return entries;
}

function getAwarenessEntryFingerprint(entry: ParsedAwarenessEntry): string {
  return JSON.stringify([entry.clientId, entry.clock, entry.state]);
}

function rememberOutboundAwarenessEntries(
  context: DeferredAwarenessContext,
  message: unknown,
): void {
  if (!(message instanceof Uint8Array)) return;
  let entries: ParsedAwarenessEntry[];
  try {
    entries = parseAwarenessEntries(message);
  } catch {
    return;
  }

  const fingerprints = context.sentAwarenessRelayFingerprints ?? new Set<string>();
  context.sentAwarenessRelayFingerprints = fingerprints;
  for (const entry of entries) {
    const fingerprint = getAwarenessEntryFingerprint(entry);
    if (fingerprints.has(fingerprint)) continue;
    while (fingerprints.size >= AWARENESS_RELAY_FINGERPRINT_LIMIT) {
      const oldest = fingerprints.values().next().value;
      if (oldest === undefined) break;
      fingerprints.delete(oldest);
    }
    fingerprints.add(fingerprint);
  }
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExactJsonValue(value: unknown, expected: unknown): boolean {
  if (value === expected) return true;
  if (Array.isArray(value) || Array.isArray(expected)) {
    return (
      Array.isArray(value) &&
      Array.isArray(expected) &&
      value.length === expected.length &&
      value.every((item, index) => isExactJsonValue(item, expected[index]))
    );
  }
  if (!isUnknownRecord(value) || !isUnknownRecord(expected)) return false;
  const valueKeys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    valueKeys.length === expectedKeys.length &&
    valueKeys.every(
      (key, index) => key === expectedKeys[index] && isExactJsonValue(value[key], expected[key]),
    )
  );
}

function hasExactPrimitiveFields(
  value: unknown,
  expected: Record<string, string | boolean | null>,
): boolean {
  if (!isUnknownRecord(value)) return false;
  const valueKeys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (valueKeys.length !== expectedKeys.length) return false;
  return expectedKeys.every(
    (key, index) => valueKeys[index] === key && value[key] === expected[key],
  );
}

class CollabAccessError extends Error {
  readonly code = 'COLLAB_ACCESS_DENIED';
  readonly accessRevision: string | undefined;

  constructor(accessRevision?: string) {
    super('Forbidden');
    this.name = 'CollabAccessError';
    this.accessRevision = accessRevision;
  }
}

class CollabVerificationError extends Error {
  readonly code = 'COLLAB_VERIFICATION_FAILED';
  readonly originalError: unknown;

  constructor(originalError: unknown) {
    super(COLLAB_TERMINAL_REASONS.PERMISSION_VERIFICATION_FAILED);
    this.name = 'CollabVerificationError';
    this.originalError = originalError;
  }
}

class CollabWriteDeniedError extends Error {
  readonly code = 4403;

  constructor() {
    super('Write permission required');
    this.name = 'CollabWriteDeniedError';
  }
}

class CollabProtocolDeniedError extends Error {
  readonly code = 4403;

  constructor(message = 'Client stateless messages are not allowed') {
    super(message);
    this.name = 'CollabProtocolDeniedError';
  }
}

function extractTitle(doc: Y.Doc): string {
  const titleText = doc.getText('title');
  return titleText.toString() || 'Untitled';
}

function isMetaRoom(documentName: string): boolean {
  return documentName.startsWith(META_ROOM_PREFIX);
}

type PageLookupRow = {
  id: string;
  title: string;
};

type PageMeta = {
  title: string;
  icon: string | null;
  parent_id: string | null;
  position: string;
};

type PageContextRow = {
  owner_id: string;
  properties: unknown;
};

type IndexedConnection = Omit<ConnectionDraft, 'targetId'> & {
  targetId: string | null;
  occurrenceCount: number;
};

type ConnectionResolutionPrincipal = {
  userId: string;
  isAnonymous: boolean;
};

/**
 * Payload received on the `share_event` pg_notify channel when a user receives
 * a new account grant. The collab server forwards this to the recipient's active
 * WebSocket connection so they see a grant notification toast.
 */
interface GrantReceivedPayload {
  type: 'grant_received';
  entityType: string;
  entityId: string;
  entityTitle: string;
  sharedByName: string;
  targetUserId: string;
  permission?: SharePermission;
  message?: string;
}

type ActiveMetaDocuments = Map<string, Document>;
type PageMetaIndexRow = PageMeta & { id: string; permission: EffectivePermission };
type QueryExecutor = Pick<PoolClient, 'query'>;

function getActiveMetaDocuments(hocuspocus: Hocuspocus): ActiveMetaDocuments {
  const documents = new Map<string, Document>();
  for (const [documentName, document] of hocuspocus.documents) {
    if (!documentName.startsWith(META_ROOM_PREFIX)) continue;
    const userId = documentName.slice(META_ROOM_PREFIX.length);
    if (!UUID_REGEX.test(userId)) continue;
    documents.set(userId, document as Document);
  }
  return documents;
}

async function rebuildPageMetaDocument(
  pool: QueryExecutor,
  userId: string,
  document: Document,
  logger: Logger,
  invalidateBacklinks = false,
): Promise<boolean> {
  const result = await pool.query<PageMetaIndexRow>(
    `select p.id, p.title, p.icon,
            case
              when p.parent_id is null or exists (
                select 1
          from get_enumerable_folder_ids($1) enumerable
                where enumerable.folder_id = p.parent_id
              ) then p.parent_id
              else null
            end as parent_id,
            p.position, access.permission
     from pages p
       join lateral get_effective_page_permission(p.id, $1) access on true
     where p.is_deleted = false
         and p.id in (select page_id from get_accessible_page_ids($1))
     order by p.position::numeric asc`,
    [userId],
  );

  const nextIds = new Set(result.rows.map((row) => row.id));
  const pageIndex = document.getMap('pageIndex');
  const permissionIndex = document.getMap<EffectivePermission>('accessPermissions');
  const membershipChanged =
    pageIndex.size !== nextIds.size || Array.from(pageIndex.keys()).some((id) => !nextIds.has(id));
  const permissionChanged =
    permissionIndex.size !== nextIds.size ||
    result.rows.some((row) => permissionIndex.get(row.id) !== row.permission);

  document.transact(() => {
    const backlinksVersion = invalidateBacklinks ? document.getMap('backlinksVersion') : undefined;
    const refreshVersion = Date.now();
    for (const id of pageIndex.keys()) {
      if (!nextIds.has(id)) pageIndex.delete(id);
    }
    for (const id of permissionIndex.keys()) {
      if (!nextIds.has(id)) permissionIndex.delete(id);
    }
    for (const row of result.rows) {
      const nextMeta = {
        title: row.title,
        icon: row.icon,
        parentId: row.parent_id,
        position: row.position,
      };
      const currentMeta = pageIndex.get(row.id) as Partial<typeof nextMeta> | undefined;
      if (
        currentMeta?.title !== nextMeta.title ||
        currentMeta.icon !== nextMeta.icon ||
        currentMeta.parentId !== nextMeta.parentId ||
        currentMeta.position !== nextMeta.position
      ) {
        pageIndex.set(row.id, nextMeta);
      }
      if (permissionIndex.get(row.id) !== row.permission) {
        permissionIndex.set(row.id, row.permission);
      }
      backlinksVersion?.set(row.id, refreshVersion);
    }
  });

  logger.debug(`[meta] loaded ${result.rows.length} pages for user ${userId}`);
  return membershipChanged || permissionChanged;
}

async function reconcileActivePageTitles(hocuspocus: Hocuspocus, pool: Pool): Promise<void> {
  const activePageIds = Array.from(hocuspocus.documents.keys()).filter((documentName) =>
    UUID_REGEX.test(documentName),
  );
  if (activePageIds.length === 0) return;

  const canonicalTitles = canonicalTitlesByServer.get(hocuspocus);
  if (!canonicalTitles) return;
  const acceptedTitles = acceptedTitlesByServer.get(hocuspocus);
  const pendingBaselines = pendingTitleBaselinesByServer.get(hocuspocus);
  for (const pageId of activePageIds) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const ownerResult = await client.query<{ owner_id: string | null }>(
        `select coalesce(get_root_folder_owner(parent_id), created_by) as owner_id
         from pages
         where id = $1 and is_deleted = false`,
        [pageId],
      );
      const ownerId = ownerResult.rows[0]?.owner_id;
      if (!ownerId) {
        await client.query('rollback');
        continue;
      }
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `workspace-access:${ownerId}`,
      ]);
      const result = await client.query<{ title: string; title_revision: string }>(
        `select title, title_revision::text as title_revision
         from pages
         where id = $1 and is_deleted = false
         for update`,
        [pageId],
      );
      const row = result.rows[0];
      const document = hocuspocus.documents.get(pageId) as Document | undefined;
      if (!row || !document) {
        await client.query('rollback');
        continue;
      }
      const currentTitle = document.getText('title');
      const previousCanonicalTitle = canonicalTitles.get(pageId);
      if (previousCanonicalTitle !== undefined && previousCanonicalTitle !== row.title) {
        const preserveLaterCollaborativeTitle =
          currentTitle.toString() !== previousCanonicalTitle &&
          pendingBaselines?.get(pageId) === row.title_revision;
        if (!preserveLaterCollaborativeTitle && currentTitle.toString() !== row.title) {
          document.transact(() => {
            currentTitle.delete(0, currentTitle.length);
            currentTitle.insert(0, row.title);
          });
          acceptedTitles?.set(pageId, row.title);
          pendingBaselines?.delete(pageId);
        }
        canonicalTitles.set(pageId, row.title);
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function rebuildActivePageMetaDocuments(
  hocuspocus: Hocuspocus,
  pool: Pool,
  logger: Logger,
  options: {
    invalidateBacklinks?: boolean;
    bumpAccessVersion?: boolean;
    reconcileTitles?: boolean;
    queryExecutor?: QueryExecutor;
  } = {},
): Promise<void> {
  const {
    invalidateBacklinks = true,
    bumpAccessVersion = false,
    reconcileTitles = true,
    queryExecutor = pool,
  } = options;
  const failures: unknown[] = [];
  if (reconcileTitles) {
    try {
      await reconcileActivePageTitles(hocuspocus, pool);
    } catch (error) {
      failures.push(error);
      logger.error(`[meta] failed to reconcile active page titles: ${error}`);
    }
  }

  for (const [userId, document] of getActiveMetaDocuments(hocuspocus)) {
    try {
      const accessChanged = await rebuildPageMetaDocument(
        queryExecutor,
        userId,
        document,
        logger,
        invalidateBacklinks,
      );
      if (accessChanged && bumpAccessVersion) {
        document.transact(() => {
          const versions = document.getMap<number>('accessVersion');
          versions.set('access', (versions.get('access') ?? 0) + 1);
        });
      }
    } catch (error) {
      failures.push(error);
      logger.error(`[meta] failed to rebuild page metadata for user ${userId}: ${error}`);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to rebuild canonical page rename state');
  }
}

async function getPageMetaRecipients(
  pool: Pool,
  pageIds: string[],
  candidateUserIds: string[],
): Promise<Map<string, string[]>> {
  if (pageIds.length === 0 || candidateUserIds.length === 0) return new Map();

  const result = await pool.query<{ page_id: string; user_id: string }>(
    `with requested as (
       select distinct unnest($1::uuid[]) as page_id
     ), active_users as (
       select distinct unnest($2::uuid[]) as user_id
     )
     select requested.page_id, active_users.user_id
     from requested
     cross join active_users
     where exists (
       select 1
             from get_accessible_page_ids(active_users.user_id) accessible
       where accessible.page_id = requested.page_id
     )`,
    [pageIds, candidateUserIds],
  );

  const recipients = new Map<string, string[]>();
  for (const row of result.rows) {
    const ids = recipients.get(row.page_id) ?? [];
    ids.push(row.user_id);
    recipients.set(row.page_id, ids);
  }
  return recipients;
}

async function getDeletedPageMetaRecipientIds(
  pool: QueryExecutor,
  pageId: string,
  candidateUserIds: string[],
): Promise<string[]> {
  if (candidateUserIds.length === 0) return [];

  const result = await pool.query<{ user_id: string }>(
    `with page_info as (
       select coalesce(
         (
           select root.created_by
           from folder_closure fc
           join folders root on root.id = fc.ancestor_id
           where fc.descendant_id = p.parent_id and root.parent_id is null
           order by fc.depth desc
           limit 1
         ),
         p.created_by
       ) as owner_id, p.parent_id
       from pages p where p.id = $1
     ), recipients as (
       select owner_id as user_id from page_info
       union
       select s.recipient_user_id
       from shares s
       where s.entity_type = 'page' and s.entity_id = $1
         and s.recipient_user_id is not null
       union
       select s.recipient_user_id
       from shares s
       join page_info pi on s.entity_id in (
         select ancestor_id from folder_closure where descendant_id = pi.parent_id
       )
       where s.entity_type = 'folder' and s.recipient_user_id is not null
       union
       select wm.member_id
       from workspace_members wm
       join page_info pi on pi.owner_id = wm.workspace_owner_id
       union
       select user_id from page_public_access_visits where page_id = $1
       union
       select visit.user_id
       from folder_public_access_visits visit
       join page_info pi on visit.folder_id in (
         select ancestor_id from folder_closure where descendant_id = pi.parent_id
       )
     )
     select distinct user_id
     from recipients
     where user_id is not null and user_id = any($2::uuid[])`,
    [pageId, candidateUserIds],
  );
  return result.rows.map((row) => row.user_id);
}

async function getDeletedFolderMetaRecipientIds(
  pool: QueryExecutor,
  folderId: string,
  candidateUserIds: string[],
): Promise<string[]> {
  if (candidateUserIds.length === 0) return [];

  const result = await pool.query<{ user_id: string }>(
    `with folder_info as (
       select coalesce(
         (
           select root.created_by
           from folder_closure fc
           join folders root on root.id = fc.ancestor_id
           where fc.descendant_id = f.id and root.parent_id is null
           order by fc.depth desc
           limit 1
         ),
         f.created_by
       ) as owner_id
       from folders f where f.id = $1
     ), related_folders as (
       select ancestor_id as folder_id from folder_closure where descendant_id = $1
       union
       select descendant_id as folder_id from folder_closure where ancestor_id = $1
     ), recipients as (
       select owner_id as user_id from folder_info
       union
       select s.recipient_user_id
       from shares s
       where s.entity_type = 'folder'
         and s.entity_id in (select folder_id from related_folders)
         and s.recipient_user_id is not null
       union
       select wm.member_id
       from workspace_members wm
       join folder_info fi on fi.owner_id = wm.workspace_owner_id
       union
       select visit.user_id
       from folder_public_access_visits visit
       where visit.folder_id in (select folder_id from related_folders)
     )
     select distinct user_id
     from recipients
     where user_id is not null and user_id = any($2::uuid[])`,
    [folderId, candidateUserIds],
  );
  return result.rows.map((row) => row.user_id);
}

async function updatePageMeta(
  hocuspocus: Hocuspocus,
  pool: Pool,
  pageId: string,
  logger: Logger,
  knownPage?: PageMeta,
  knownRecipients?: Map<string, string[]>,
  knownActiveDocuments?: ActiveMetaDocuments,
): Promise<void> {
  const activeDocuments = knownActiveDocuments ?? getActiveMetaDocuments(hocuspocus);
  if (activeDocuments.size === 0) return;

  let page = knownPage;
  if (!page) {
    const pageResult = await pool.query<PageMeta>(
      'select title, icon, parent_id, position from pages where id = $1 and is_deleted = false',
      [pageId],
    );
    page = pageResult.rows[0];
  }
  if (!page) return;

  const recipients =
    knownRecipients ??
    (await getPageMetaRecipients(pool, [pageId], Array.from(activeDocuments.keys())));
  const recipientIds = recipients.get(pageId) ?? [];
  const parentVisibleTo = new Set<string>();
  if (page.parent_id && recipientIds.length > 0) {
    const visibility = await pool.query<{ user_id: string }>(
      `select requested.user_id
       from unnest($1::uuid[]) requested(user_id)
       where exists (
         select 1
             from get_enumerable_folder_ids(requested.user_id) enumerable
         where enumerable.folder_id = $2
       )`,
      [recipientIds, page.parent_id],
    );
    for (const row of visibility.rows) parentVisibleTo.add(row.user_id);
  }
  const failures: unknown[] = [];
  for (const recipientId of recipientIds) {
    const metaDoc = activeDocuments.get(recipientId);
    if (!metaDoc) continue;
    try {
      metaDoc.transact(() => {
        const pageIndex = metaDoc.getMap('pageIndex');
        pageIndex.set(pageId, {
          title: page.title,
          icon: page.icon,
          parentId: parentVisibleTo.has(recipientId) ? page.parent_id : null,
          position: page.position,
        });
      });
    } catch (error) {
      failures.push(error);
      logger.error(
        `[meta] failed to update meta for user ${recipientId} on page ${pageId}: ${error}`,
      );
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `Failed to update page metadata for ${pageId}`);
  }
}

function extractPropertyTags(properties: unknown): ConnectionDraft[] {
  if (!properties || typeof properties !== 'object') return [];
  const tagsValue = (properties as Record<string, unknown>).tags;
  const rawTags = Array.isArray(tagsValue)
    ? tagsValue
    : typeof tagsValue === 'string'
      ? tagsValue.split(',')
      : [];

  return rawTags
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => normalizeTagSlug(tag))
    .filter(Boolean)
    .map((tag) => ({
      targetType: 'tag',
      targetSlug: tag,
      targetLabel: tag,
      connectionType: 'tag',
      linkText: tag,
    }));
}

function connectionKey(connection: ConnectionDraft): string {
  return [
    connection.targetType,
    connection.targetSlug,
    connection.connectionType,
    connection.targetId ?? '',
  ].join('\u001f');
}

function aggregateConnections(connections: ConnectionDraft[]): IndexedConnection[] {
  const byKey = new Map<string, IndexedConnection>();

  for (const connection of connections) {
    const key = connectionKey(connection);
    const existing = byKey.get(key);
    if (existing) {
      existing.occurrenceCount += 1;
      continue;
    }

    const indexed: IndexedConnection = {
      ...connection,
      targetId: connection.targetId ?? null,
      occurrenceCount: 1,
    };
    byKey.set(key, indexed);
  }

  return [...byKey.values()];
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function resolvePageTargets(
  client: PoolClient,
  ownerId: string,
  connections: IndexedConnection[],
  principals: ConnectionResolutionPrincipal[],
  staleTargets?: Map<string, string>,
): Promise<void> {
  // A persistence path without an attributable writer must never fall back to
  // owner-wide discovery. Keep authored labels, but leave every page target
  // unresolved until a later authorized writer saves the document.
  if (principals.length === 0) {
    for (const connection of connections) {
      if (connection.targetType === 'page') connection.targetId = null;
    }
    return;
  }

  const authenticatedUserIds = [
    ...new Set(
      principals.filter((principal) => !principal.isAnonymous).map((principal) => principal.userId),
    ),
  ];
  const hasAnonymousPrincipal = principals.some((principal) => principal.isAnonymous);
  const ids = [
    ...new Set(
      connections
        .filter((connection) => connection.targetType === 'page' && connection.targetId)
        .map((connection) => connection.targetId)
        .filter((id): id is string => typeof id === 'string' && isUuid(id))
        .concat(
          // Include stale targetIds so they are pre-fetched for fallback resolution.
          // This covers the case where the target page was renamed: the slug from
          // the wiki link content still points to the old slug, but the stale
          // targetId gives us the actual page UUID to look up.
          ...(staleTargets
            ? [...staleTargets.values()].filter((id): id is string => !!id && isUuid(id))
            : []),
        ),
    ),
  ];
  const slugs = [
    ...new Set(
      connections
        .filter((connection) => connection.targetType === 'page')
        .map((connection) => connection.targetSlug)
        .filter(Boolean),
    ),
  ];

  const byId = new Map<string, PageLookupRow>();
  const bySlug = new Map<string, PageLookupRow>();

  if (ids.length > 0) {
    const result = await client.query<PageLookupRow>(
      `select p.id, p.title
       from pages p
       where p.id = any($1::uuid[])
         and p.is_deleted = false
         and coalesce(get_root_folder_owner(p.parent_id), p.created_by) = $2
         and not exists (
           select 1
           from unnest($3::uuid[]) actor(user_id)
           where not exists (
             select 1
             from get_accessible_page_ids(actor.user_id) accessible
             where accessible.page_id = p.id
           )
         )
         and (not $4::boolean or get_public_page_permission(p.id) is not null)`,
      [ids, ownerId, authenticatedUserIds, hasAnonymousPrincipal],
    );
    for (const row of result.rows) {
      byId.set(row.id, row);
    }
  }

  const titleSlugs = slugs.filter((slug) => !slug.includes('/'));
  if (titleSlugs.length > 0) {
    const result = await client.query<PageLookupRow & { normalized_title: string }>(
      `select min(p.id::text) as id,
              min(p.title) as title,
              lower(trim(p.title)) as normalized_title
       from pages p
       where coalesce(get_root_folder_owner(p.parent_id), p.created_by) = $1
         and lower(trim(p.title)) = any($2::text[])
         and p.is_deleted = false
         and not exists (
           select 1
           from unnest($3::uuid[]) actor(user_id)
           where not exists (
             select 1
             from get_accessible_page_ids(actor.user_id) accessible
             where accessible.page_id = p.id
           )
         )
         and (not $4::boolean or get_public_page_permission(p.id) is not null)
       group by lower(trim(p.title))
       having count(*) = 1`,
      [ownerId, titleSlugs, authenticatedUserIds, hasAnonymousPrincipal],
    );
    for (const row of result.rows) {
      bySlug.set(row.normalized_title, row);
    }
  }

  const pathSlugs = slugs.filter((slug) => slug.includes('/'));
  if (pathSlugs.length > 0) {
    const result = await client.query<PageLookupRow & { normalized_path: string }>(
      `with recursive visible_folders as materialized (
         select f.id, f.parent_id, f.name
         from folders f
         where f.is_deleted = false
           and get_root_folder_owner(f.id) = $1
           and not exists (
             select 1
             from unnest($3::uuid[]) actor(user_id)
             where not exists (
               select 1
         from get_enumerable_folder_ids(actor.user_id) enumerable
               where enumerable.folder_id = f.id
             )
           )
           and (not $4::boolean or get_public_folder_permission(f.id) is not null)
       ),
       folder_paths as (
         select f.id, lower(trim(f.name))::text as folder_path
         from visible_folders f
         where not exists (
           select 1 from visible_folders parent where parent.id = f.parent_id
         )
         union all
         select child.id,
                (parent.folder_path || '/' || lower(trim(child.name)))::text
         from visible_folders child
         join folder_paths parent on parent.id = child.parent_id
       )
       select min(p.id::text) as id,
              min(p.title) as title,
              paths.folder_path || '/' || lower(trim(p.title)) as normalized_path
       from pages p
       join folder_paths paths on paths.id = p.parent_id
       where p.is_deleted = false
         and paths.folder_path || '/' || lower(trim(p.title)) = any($2::text[])
         and not exists (
           select 1
           from unnest($3::uuid[]) actor(user_id)
           where not exists (
             select 1
             from get_accessible_page_ids(actor.user_id) accessible
             where accessible.page_id = p.id
           )
         )
         and (not $4::boolean or get_public_page_permission(p.id) is not null)
       group by paths.folder_path || '/' || lower(trim(p.title))
       having count(*) = 1`,
      [ownerId, pathSlugs, authenticatedUserIds, hasAnonymousPrincipal],
    );
    for (const row of result.rows) {
      bySlug.set(row.normalized_path, row);
    }
  }

  for (const connection of connections) {
    if (connection.targetType !== 'page') continue;

    const byIdMatch = connection.targetId ? byId.get(connection.targetId) : undefined;
    if (byIdMatch) {
      connection.targetLabel = byIdMatch.title;
      continue;
    }

    // Never retain a client-provided target outside the source workspace.
    // Trusted index and slug resolution below may replace this with a target
    // that was returned by the workspace-scoped lookup.
    connection.targetId = null;

    // Prefer the previously validated server-side mapping over title lookup.
    // A rename can make the old title uniquely identify a *different* page,
    // so treating this as a fallback would silently retarget the link.
    if (staleTargets) {
      const staleId = staleTargets.get(connection.targetSlug);
      const staleMatch = staleId ? byId.get(staleId) : undefined;
      if (staleId && staleMatch) {
        connection.targetId = staleId;
        connection.targetLabel = staleMatch.title;
        continue;
      }
    }

    const bySlugMatch = bySlug.get(connection.targetSlug);
    if (bySlugMatch) {
      connection.targetId = bySlugMatch.id;
      connection.targetLabel = bySlugMatch.title;
    }
  }
}

async function updateConnections(
  client: PoolClient,
  pageId: string,
  ydocUpdate: Uint8Array,
  resolutionPrincipals: ConnectionResolutionPrincipal[],
  logger: Logger,
): Promise<string[]> {
  const pageResult = await client.query<PageContextRow>(
    `select coalesce(get_root_folder_owner(parent_id), created_by) as owner_id, properties
     from pages where id = $1`,
    [pageId],
  );
  const page = pageResult.rows[0];
  if (!page) {
    logger.warn(`[connections] page ${pageId} not found, skipping connection update`);
    return [];
  }

  // Capture existing targetId mappings before deletion, so we can fall back
  // to them when slug-based resolution fails (e.g., after a target page rename).
  const existingResult = await client.query<{
    target_slug: string;
    target_id: string | null;
  }>(
    `select target_slug, target_id from connections
     where source_type = 'page' and source_id = $1 and target_type = 'page'`,
    [pageId],
  );
  const staleTargets = new Map<string, string>();
  const previousTargetPageIds = new Set<string>();
  for (const row of existingResult.rows) {
    if (row.target_slug && row.target_id && !staleTargets.has(row.target_slug)) {
      staleTargets.set(row.target_slug, row.target_id);
    }
    if (row.target_id) previousTargetPageIds.add(row.target_id);
  }

  const extracted = extractConnectionsFromYDoc(ydocUpdate);
  const propertyTags = extractPropertyTags(page.properties);
  const indexedConnections = aggregateConnections([...extracted, ...propertyTags]);
  await resolvePageTargets(
    client,
    page.owner_id,
    indexedConnections,
    resolutionPrincipals,
    staleTargets,
  );

  await client.query('delete from connections where source_type = $1 and source_id = $2', [
    'page',
    pageId,
  ]);

  for (const connection of indexedConnections) {
    const insertResult = await client.query<{ id: string }>(
      `insert into connections (
         source_type, source_id, target_type, target_id, target_slug,
         target_label, connection_type, link_text, link_context, occurrence_count, updated_at
       )
       values ('page', $1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       returning id`,
      [
        pageId,
        connection.targetType,
        connection.targetId,
        connection.targetSlug,
        connection.targetLabel,
        connection.connectionType,
        connection.linkText ?? null,
        connection.linkContext ?? null,
        connection.occurrenceCount,
      ],
    );

    const connectionId = insertResult.rows[0]?.id;
    if (!connectionId || !connection.linkContext) continue;

    await client.query(
      `insert into connection_occurrences (connection_id, context)
       values ($1, $2)`,
      [connectionId, connection.linkContext],
    );
  }

  logger.debug(`[connections] updated ${indexedConnections.length} connections for page ${pageId}`);

  // Notify targets on both sides of the replacement. Removed targets need to
  // refetch just as much as newly linked targets do.
  return [
    ...new Set([
      ...previousTargetPageIds,
      ...indexedConnections
        .filter(
          (connection): connection is IndexedConnection & { targetId: string } =>
            connection.targetType === 'page' && !!connection.targetId,
        )
        .map((connection) => connection.targetId),
    ]),
  ];
}

async function updateBacklinksVersion(
  hocuspocus: Hocuspocus,
  pool: Pool,
  pageIds: string[],
  logger: Logger,
  knownRecipients?: Map<string, string[]>,
  knownActiveDocuments?: ActiveMetaDocuments,
): Promise<void> {
  if (pageIds.length === 0) return;

  const activeDocuments = knownActiveDocuments ?? getActiveMetaDocuments(hocuspocus);
  if (activeDocuments.size === 0) return;

  const pageIdsByRecipient = new Map<string, string[]>();
  const recipientsByPage =
    knownRecipients ??
    (await getPageMetaRecipients(pool, pageIds, Array.from(activeDocuments.keys())));
  for (const pageId of pageIds) {
    for (const recipientId of recipientsByPage.get(pageId) ?? []) {
      const ids = pageIdsByRecipient.get(recipientId) ?? [];
      ids.push(pageId);
      pageIdsByRecipient.set(recipientId, ids);
    }
  }

  const failures: unknown[] = [];
  for (const [recipientId, recipientPageIds] of pageIdsByRecipient) {
    const metaDoc = activeDocuments.get(recipientId);
    if (!metaDoc) continue;
    try {
      metaDoc.transact(() => {
        const bv = metaDoc.getMap<number>('backlinksVersion');
        const now = Date.now();
        for (const id of recipientPageIds) {
          const current = bv.get(id);
          bv.set(id, current === undefined ? now : Math.max(now, current + 1));
        }
      });
    } catch (error) {
      failures.push(error);
      logger.error(`[meta] failed to update backlinksVersion for user ${recipientId}: ${error}`);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to update backlinks metadata');
  }
}

type PersistDocumentResult =
  | { committed: false }
  | { committed: true; canonicalTitle: string; stateSize: number };

async function persistDocument(
  pool: Pool,
  hocuspocus: Hocuspocus,
  documentName: string,
  document: Y.Doc,
  connectionSnapshotState: Uint8Array,
  connectionResolutionPrincipals: ConnectionResolutionPrincipal[],
  lastCanonicalTitle: string | undefined,
  maxDocumentBytes: number,
  logger: Logger,
  authorizePersistence?: (client: PoolClient) => Promise<boolean>,
  attempt = 1,
): Promise<PersistDocumentResult> {
  const client = await pool.connect();
  let targetPageIds: string[] = [];
  let pageMeta: PageMeta | undefined;
  let committedStateSize = 0;
  let committedTitle = lastCanonicalTitle ?? 'Untitled';
  let committedWhileDeleted = false;

  try {
    await client.query('BEGIN');
    if (authorizePersistence && !(await authorizePersistence(client))) {
      await client.query('ROLLBACK');
      return { committed: false };
    }

    // Lock and merge the latest SQL snapshot before encoding. This prevents a
    // delayed collab save from replacing a newer API rename or Yjs snapshot.
    const currentResult = await client.query<{
      ydoc: Buffer | null;
      title: string;
      is_deleted: boolean;
      title_revision: string;
    }>(
      `select ydoc, title, is_deleted, title_revision::text as title_revision
       from pages
       where id = $1
       for update`,
      [documentName],
    );
    const current = currentResult.rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      return { committed: false };
    }
    // Connection extraction is bound to the immutable Yjs snapshot captured
    // with its writer principals. The live document may accept later updates
    // while this transaction waits; those are indexed by their own save.
    const connectionSnapshot = new Y.Doc();
    Y.applyUpdate(connectionSnapshot, connectionSnapshotState);
    if (current.ydoc && current.ydoc.length > 0) {
      // API imports and pre-invariant snapshots may contain legacy targetId
      // attributes. Sanitize in an isolated document before merging so the
      // raw update can never be emitted from the live room during this save.
      const canonicalCurrentState = sanitizeCanonicalYjsUpdate(new Uint8Array(current.ydoc));
      Y.applyUpdate(document, canonicalCurrentState);
      Y.applyUpdate(connectionSnapshot, canonicalCurrentState);
    }
    stripWikiLinkTargetIds(document);
    stripWikiLinkTargetIds(connectionSnapshot);
    const connectionState = Y.encodeStateAsUpdate(connectionSnapshot);
    connectionSnapshot.destroy();

    // A SQL title that differs from the last title observed from PostgreSQL is
    // an external/API rename. It wins over a stale in-memory Y.Text value.
    const pendingTitleBaseline = pendingTitleBaselinesByServer.get(hocuspocus)?.get(documentName);
    const externalRenameWins =
      lastCanonicalTitle !== undefined &&
      current.title !== lastCanonicalTitle &&
      pendingTitleBaseline !== current.title_revision;
    if (externalRenameWins) {
      document.transact(() => {
        const titleText = document.getText('title');
        titleText.delete(0, titleText.length);
        titleText.insert(0, current.title);
      });
    }

    const state = Y.encodeStateAsUpdate(document);
    if (state.length > maxDocumentBytes) {
      throw new Error('Document size limit exceeded');
    }
    const persistedTitle = {
      fieldExisted: document.share.has('title'),
      value: extractTitle(document),
    };

    if (current.is_deleted) {
      // A write that passed the serialized authorization fence can reach Yjs
      // immediately before a concurrent Trash mutation commits. Preserve that
      // already-linearized state in the trashed row, but do not rebuild search,
      // connections, or active metadata until the page is restored.
      const hasMeaningfulTitle = persistedTitle.fieldExisted && persistedTitle.value !== 'Untitled';
      if (hasMeaningfulTitle) {
        await client.query(
          `update pages
           set ydoc = $1,
               title_revision = title_revision + case when title is distinct from $2 then 1 else 0 end,
               title = $2,
               updated_at = now()
           where id = $3 and is_deleted = true`,
          [state, persistedTitle.value, documentName],
        );
        committedTitle = persistedTitle.value;
      } else {
        await client.query(
          'update pages set ydoc = $1, updated_at = now() where id = $2 and is_deleted = true',
          [state, documentName],
        );
        committedTitle = current.title;
      }
      committedWhileDeleted = true;
    } else if (persistedTitle.fieldExisted) {
      // Only update the pages.title column when the extracted title is
      // meaningful. This prevents auto-created empty title types (e.g. when a
      // page was imported via markdown without a Y.Doc title field) from
      // overwriting the real title with 'Untitled'. The Y.Doc binary is always
      // saved regardless so the title can be recovered on next load.
      const hasMeaningfulTitle = persistedTitle.value !== 'Untitled';
      if (hasMeaningfulTitle) {
        await client.query(
          `update pages
           set ydoc = $1,
               title_revision = title_revision + case when title is distinct from $2 then 1 else 0 end,
               title = $2,
               title_search = to_tsvector('english', $2),
               updated_at = now()
           where id = $3`,
          [state, persistedTitle.value, documentName],
        );
      } else {
        await client.query('update pages set ydoc = $1, updated_at = NOW() where id = $2', [
          state,
          documentName,
        ]);
      }
    } else {
      await client.query('update pages set ydoc = $1, updated_at = NOW() where id = $2', [
        state,
        documentName,
      ]);
    }
    if (!committedWhileDeleted) {
      targetPageIds = await updateConnections(
        client,
        documentName,
        connectionState,
        connectionResolutionPrincipals,
        logger,
      );
      const metaResult = await client.query<PageMeta>(
        'select title, icon, parent_id, position from pages where id = $1',
        [documentName],
      );
      pageMeta = metaResult.rows[0];
    }

    await client.query('COMMIT');
    committedStateSize = state.length;
    committedTitle = pageMeta?.title ?? committedTitle ?? current.title;
  } catch (err) {
    await client.query('ROLLBACK');

    // Retry on PostgreSQL deadlock (40P01). The transaction was rolled back
    // by the server, so a fresh attempt with exponential backoff is safe.
    const pgErr = err as { code?: string } | undefined;
    if (pgErr?.code === '40P01' && attempt < 3) {
      logger.warn(`[persist] deadlock on page ${documentName}, retrying (attempt ${attempt})`);
      const delay = Math.min(50 * 2 ** attempt, 500);
      await new Promise((r) => setTimeout(r, delay));
      return persistDocument(
        pool,
        hocuspocus,
        documentName,
        document,
        connectionSnapshotState,
        connectionResolutionPrincipals,
        lastCanonicalTitle,
        maxDocumentBytes,
        logger,
        authorizePersistence,
        attempt + 1,
      );
    }

    logger.error(`[persist] failed for page ${documentName}: ${err}`);
    throw err;
  } finally {
    client.release();
  }

  // Notify only currently connected meta rooms. Offline users rebuild their
  // metadata from PostgreSQL when they reconnect, so opening rooms for them
  // here would add save latency without preserving useful state.
  if (committedWhileDeleted) {
    return { committed: true, canonicalTitle: committedTitle, stateSize: committedStateSize };
  }

  const activeDocuments = getActiveMetaDocuments(hocuspocus);
  if (activeDocuments.size === 0) {
    return { committed: true, canonicalTitle: committedTitle, stateSize: committedStateSize };
  }

  try {
    const affectedIds = [...new Set([documentName, ...targetPageIds])];
    const recipients = await getPageMetaRecipients(
      pool,
      affectedIds,
      Array.from(activeDocuments.keys()),
    );
    const results = await Promise.allSettled([
      updatePageMeta(hocuspocus, pool, documentName, logger, pageMeta, recipients, activeDocuments),
      updateBacklinksVersion(hocuspocus, pool, affectedIds, logger, recipients, activeDocuments),
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason as unknown);
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to publish metadata for ${documentName}`);
    }
  } catch (error) {
    // PostgreSQL is already committed. Do not report the save as failed or
    // retain its pending writer: metadata rooms rebuild from canonical state.
    logger.error(
      `[persist] metadata publication failed after commit for page=${documentName}: ${error}`,
    );
  }
  return { committed: true, canonicalTitle: committedTitle, stateSize: committedStateSize };
}

export async function publishPageRename(
  hocuspocus: Hocuspocus,
  pool: Pool,
  pageId: string,
  newTitle: string,
  logger: Logger,
  options: { applyToActive?: boolean } = {},
): Promise<void> {
  const activeDoc = hocuspocus.documents.get(pageId) as Y.Doc | undefined;
  if (activeDoc && options.applyToActive !== false) {
    const beforeTitle = activeDoc.getText('title').toString();
    if (beforeTitle !== newTitle) {
      activeDoc.transact(() => {
        const titleText = activeDoc.getText('title');
        titleText.delete(0, titleText.length);
        titleText.insert(0, newTitle);
      });
      logger.debug(
        `[listen] pushed rename to active session for page ${pageId}: "${beforeTitle}" -> "${newTitle}"`,
      );
    }
  }

  const results = await Promise.allSettled([
    updatePageMeta(hocuspocus, pool, pageId, logger),
    updateBacklinksVersion(hocuspocus, pool, [pageId], logger),
  ]);
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') continue;
    failures.push(result.reason);
    logger.error(`[listen] failed to publish rename metadata for page ${pageId}: ${result.reason}`);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Failed to publish rename metadata for ${pageId}`);
  }

  logger.debug(`[listen] updated meta for renamed page ${pageId} -> ${newTitle}`);
}

type DeletionPublicationEntity = 'page' | 'folder';

type DeletionPublicationState = {
  is_deleted: boolean;
  owner_id: string | null;
};

async function getDeletionPublicationState(
  client: PoolClient,
  entityType: DeletionPublicationEntity,
  entityId: string,
): Promise<DeletionPublicationState | undefined> {
  const result =
    entityType === 'page'
      ? await client.query<DeletionPublicationState>(
          `select p.is_deleted,
                  coalesce(
                    (
                      select root.created_by
                      from folder_closure fc
                      join folders root on root.id = fc.ancestor_id
                      where fc.descendant_id = p.parent_id
                        and root.parent_id is null
                      order by fc.depth desc
                      limit 1
                    ),
                    (
                      select parent.created_by
                      from folders parent
                      where parent.id = p.parent_id
                    ),
                    p.created_by
                  ) as owner_id
           from pages p
           where p.id = $1`,
          [entityId],
        )
      : await client.query<DeletionPublicationState>(
          `select f.is_deleted,
                  coalesce(
                    (
                      select root.created_by
                      from folder_closure fc
                      join folders root on root.id = fc.ancestor_id
                      where fc.descendant_id = f.id
                        and root.parent_id is null
                      order by fc.depth desc
                      limit 1
                    ),
                    f.created_by
                  ) as owner_id
           from folders f
           where f.id = $1`,
          [entityId],
        );
  return result.rows[0];
}

/**
 * Deletion notifications race with restore/move notifications on independent
 * in-process queues. Serialize the canonical recheck and every publication
 * side effect with the workspace advisory lock used by API delete, restore,
 * and organization mutations. A purged row cannot be restored and therefore
 * needs no owner lock; it remains a canonical deletion.
 */
async function publishCanonicalDeletion(
  pool: Pool,
  entityType: DeletionPublicationEntity,
  entityId: string,
  publish: (client: PoolClient, missing: boolean) => Promise<void>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      const beforeLock = await getDeletionPublicationState(client, entityType, entityId);

      if (beforeLock) {
        if (!beforeLock.owner_id) {
          throw new Error(`Cannot resolve workspace owner for ${entityType} ${entityId}`);
        }
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `workspace-access:${beforeLock.owner_id}`,
        ]);
      }

      const current = beforeLock
        ? await getDeletionPublicationState(client, entityType, entityId)
        : undefined;
      if (current?.owner_id && beforeLock?.owner_id && current.owner_id !== beforeLock.owner_id) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        continue;
      }
      if (current && !current.is_deleted) {
        await client.query('COMMIT');
        transactionOpen = false;
        return false;
      }

      await publish(client, current === undefined);
      await client.query('COMMIT');
      transactionOpen = false;
      return true;
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  throw new Error(`Workspace owner changed repeatedly for ${entityType} ${entityId}`);
}

function closeDeletedPageConnections(hocuspocus: Hocuspocus, pageId: string): void {
  const activeDoc = hocuspocus.documents.get(pageId) as Document | undefined;
  if (!activeDoc) return;

  for (const connection of activeDoc.getConnections()) {
    connection.sendStateless(
      JSON.stringify({
        type: 'entity_deleted',
        entityType: 'page',
        entityId: pageId,
      }),
    );
    // Hocuspocus preserves this shared reason in its per-document close frame,
    // while normalizing the browser-visible code to 1000.
    connection.close({ code: 4402, reason: COLLAB_TERMINAL_REASONS.PAGE_DELETED });
  }
}

export async function publishPageDeletion(
  hocuspocus: Hocuspocus,
  pool: Pool,
  pageId: string,
  logger: Logger,
): Promise<void> {
  const published = await publishCanonicalDeletion(
    pool,
    'page',
    pageId,
    async (client, missing) => {
      const activeDocuments = getActiveMetaDocuments(hocuspocus);
      const previousTargetPageIds = missing
        ? []
        : (
            await client.query<{ target_id: string }>(
              `select distinct target_id
               from connections
               where source_type = 'page' and source_id = $1
                 and target_type = 'page' and target_id is not null`,
              [pageId],
            )
          ).rows.map((row) => row.target_id);
      let recipientIds: string[];
      try {
        recipientIds = missing
          ? Array.from(activeDocuments)
              .filter(([, document]) => {
                return (
                  document.getMap('pageIndex').has(pageId) ||
                  document.getMap('accessPermissions').has(pageId) ||
                  document.getMap('backlinksVersion').has(pageId)
                );
              })
              .map(([recipientId]) => recipientId)
          : await getDeletedPageMetaRecipientIds(
              client,
              pageId,
              Array.from(activeDocuments.keys()),
            );
      } catch (error) {
        // The canonical row is deleted even if auxiliary recipient history is
        // unavailable, so fail closed for live page connections before retry.
        closeDeletedPageConnections(hocuspocus, pageId);
        throw error;
      }
      closeDeletedPageConnections(hocuspocus, pageId);
      const failures: unknown[] = [];

      for (const recipientId of recipientIds) {
        const metaDoc = activeDocuments.get(recipientId);
        if (!metaDoc) continue;
        try {
          metaDoc.transact(() => {
            metaDoc.getMap('pageIndex').delete(pageId);
            metaDoc.getMap('accessPermissions').delete(pageId);
            metaDoc.getMap('backlinksVersion').set(pageId, Date.now());
          });
        } catch (error) {
          failures.push(error);
          logger.error(
            `[listen] failed to remove page ${pageId} from meta for user ${recipientId}: ${error}`,
          );
        }
      }

      try {
        await updateBacklinksVersion(
          hocuspocus,
          pool,
          previousTargetPageIds,
          logger,
          undefined,
          activeDocuments,
        );
      } catch (error) {
        failures.push(error);
      }

      if (failures.length > 0) {
        throw new AggregateError(failures, `Failed to publish deletion metadata for ${pageId}`);
      }
    },
  );

  logger.debug(
    published
      ? `[listen] removed deleted page ${pageId} from active meta rooms`
      : `[listen] ignored stale page deletion for restored page ${pageId}`,
  );
}

export async function publishFolderDeletion(
  hocuspocus: Hocuspocus,
  pool: Pool,
  folderId: string,
  logger: Logger,
): Promise<void> {
  let deletedActivePageCount = 0;
  const published = await publishCanonicalDeletion(
    pool,
    'folder',
    folderId,
    async (client, missing) => {
      const activePageIds = Array.from(hocuspocus.documents.keys()).filter((documentName) =>
        UUID_REGEX.test(documentName),
      );
      const deletedActivePages =
        activePageIds.length === 0
          ? []
          : (
              await client.query<{ id: string }>(
                missing
                  ? `select requested.id
                     from unnest($1::uuid[]) requested(id)
                     left join pages p on p.id = requested.id
                     where p.id is null`
                  : `select requested.id
                     from unnest($2::uuid[]) requested(id)
                     left join pages p on p.id = requested.id
                     where p.id is null
                        or (
                          p.parent_id in (
                            select descendant_id from folder_closure where ancestor_id = $1
                          )
                          and p.is_deleted = true
                        )`,
                missing ? [activePageIds] : [folderId, activePageIds],
              )
            ).rows.map((row) => row.id);
      deletedActivePageCount = deletedActivePages.length;

      const activeDocuments = getActiveMetaDocuments(hocuspocus);
      // Once a folder row is purged there is no authoritative way to identify
      // its former recipients. Reconcile stale page indexes without disclosing
      // the purged folder UUID to unrelated active workspaces.
      let recipientIds: string[];
      try {
        recipientIds = missing
          ? []
          : await getDeletedFolderMetaRecipientIds(
              client,
              folderId,
              Array.from(activeDocuments.keys()),
            );
      } catch (error) {
        for (const pageId of deletedActivePages) {
          closeDeletedPageConnections(hocuspocus, pageId);
        }
        throw error;
      }

      for (const pageId of deletedActivePages) {
        closeDeletedPageConnections(hocuspocus, pageId);
      }

      const failures: unknown[] = [];
      try {
        await rebuildActivePageMetaDocuments(hocuspocus, pool, logger, {
          reconcileTitles: false,
          queryExecutor: client,
        });
      } catch (error) {
        failures.push(error);
        logger.error(
          `[listen] failed to rebuild metadata after folder deletion ${folderId}: ${error}`,
        );
      }

      try {
        const message = JSON.stringify({
          type: 'entity_deleted',
          entityType: 'folder',
          entityId: folderId,
        });
        for (const recipientId of recipientIds) {
          const metaDoc = activeDocuments.get(recipientId);
          if (!metaDoc) continue;
          for (const connection of metaDoc.getConnections()) {
            connection.sendStateless(message);
          }
        }
      } catch (error) {
        failures.push(error);
        logger.error(
          `[listen] failed to publish folder metadata deletion for ${folderId}: ${error}`,
        );
      }

      if (failures.length > 0) {
        throw new AggregateError(failures, `Failed to publish all deletion events for ${folderId}`);
      }
    },
  );

  logger.debug(
    published
      ? `[listen] published folder deletion and closed ${deletedActivePageCount} active page(s) for ${folderId}`
      : `[listen] ignored stale folder deletion for restored folder ${folderId}`,
  );
}

async function reconcileDeletionOverflow(
  hocuspocus: Hocuspocus,
  pool: Pool,
  logger: Logger,
): Promise<void> {
  const activePageIds = Array.from(hocuspocus.documents.keys()).filter((documentName) =>
    UUID_REGEX.test(documentName),
  );
  if (activePageIds.length > 0) {
    const result = await pool.query<{ id: string }>(
      `SELECT requested.id
       FROM unnest($1::uuid[]) requested(id)
       LEFT JOIN pages p ON p.id = requested.id
       WHERE p.id IS NULL OR p.is_deleted = true`,
      [activePageIds],
    );
    for (const row of result.rows) closeDeletedPageConnections(hocuspocus, row.id);
  }

  await rebuildActivePageMetaDocuments(hocuspocus, pool, logger, { reconcileTitles: false });
  const invalidationMessage = JSON.stringify({
    type: 'workspace_membership_event',
    action: 'role_changed',
    ownerId: 'all',
  });
  for (const document of getActiveMetaDocuments(hocuspocus).values()) {
    for (const connection of document.getConnections()) {
      connection.sendStateless(invalidationMessage);
    }
  }
}

/** Canonical recovery after a LISTEN subscription (initial or reconnected). */
export async function reconcileActiveCollaborationState(
  server: Server,
  pool: Pool,
  logger: Logger,
): Promise<void> {
  await Promise.all([
    reconcileActivePageTitles(server.hocuspocus, pool),
    reconcileDeletionOverflow(server.hocuspocus, pool, logger),
    revalidateActivePageConnections(server, pool, logger),
  ]);
}

export interface CollabServerConfig {
  port: number;
  pool: Pool;
  logger: Logger;
  debounceMs?: number;
  maxDebounceMs?: number;
  databaseUrl?: string;
  permissionRevalidationMs?: number;
  applicationFenceTimeoutMs?: number;
  maxPayloadBytes?: number;
  maxDocumentBytes?: number;
}

export function createCollabServer(config: CollabServerConfig) {
  const {
    port,
    pool,
    logger,
    debounceMs = 500,
    maxDebounceMs = 3000,
    permissionRevalidationMs = 5000,
    applicationFenceTimeoutMs = APPLICATION_FENCE_TIMEOUT_MS,
    maxPayloadBytes = DEFAULT_MAX_COLLAB_PAYLOAD_BYTES,
    maxDocumentBytes = MAX_YDOC_BYTES,
  } = config;
  if (!Number.isInteger(maxPayloadBytes) || maxPayloadBytes < 1) {
    throw new Error('maxPayloadBytes must be a positive integer');
  }
  if (!Number.isInteger(maxDocumentBytes) || maxDocumentBytes < 1) {
    throw new Error('maxDocumentBytes must be a positive integer');
  }
  if (!Number.isInteger(applicationFenceTimeoutMs) || applicationFenceTimeoutMs < 1) {
    throw new Error('applicationFenceTimeoutMs must be a positive integer');
  }
  type PersistContext = {
    user?: {
      id: string;
      name?: string;
      avatarUrl?: string | null;
      isAnonymous?: boolean;
    };
    permission?: EffectivePermission | null;
    accessRevision?: string;
    sessionToken?: string;
    permissionCheck?: Promise<void>;
    deferInitialAwareness?: boolean;
    establishmentGate?: EstablishmentGate;
    applicationsInFlight?: number;
    applicationCheck?: Promise<void>;
    resolveApplicationCheck?: () => void;
    pendingCloseEvent?: { code?: number; reason?: string };
    closeAfterApplicationScheduled?: boolean;
    awarenessClientId?: number;
    sentAwarenessRelayFingerprints?: Set<string>;
    pendingWriteAdmissions?: WriteAdmission[];
  };
  type PermissionQueryExecutor = Pick<Pool, 'query'>;
  type PendingWriter = {
    context: PersistContext;
    version: number;
    admittedAccessRevision?: string;
  };
  const pendingWriters = new Map<string, Map<string, PendingWriter>>();
  const documentChangeVersions = new Map<string, number>();
  const blockedDocuments = new Set<string>();
  const documentSizeEstimates = new Map<string, number>();
  const acceptedPageTitles = new Map<string, string>();
  const canonicalPageTitles = new Map<string, string>();
  const pendingTitleBaselines = new Map<string, string>();
  const activeApplicationFences = new Set<ApplicationFence>();

  function beginApplicationCheck(context: PersistContext): void {
    if ((context.applicationsInFlight ?? 0) === 0) {
      context.applicationCheck = new Promise<void>((resolve) => {
        context.resolveApplicationCheck = resolve;
      });
    }
    context.applicationsInFlight = (context.applicationsInFlight ?? 0) + 1;
  }

  function finishApplicationCheck(context: PersistContext): void {
    const remaining = Math.max(0, (context.applicationsInFlight ?? 1) - 1);
    context.applicationsInFlight = remaining;
    if (remaining > 0) return;
    context.resolveApplicationCheck?.();
    delete context.resolveApplicationCheck;
    delete context.applicationCheck;
    delete context.applicationsInFlight;
  }

  async function runPermissionQuery<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new CollabVerificationError(error);
    }
  }

  async function withSerializedPermissionCheck<T>(
    context: PersistContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = context.permissionCheck ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    context.permissionCheck = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  function getCanonicalAwarenessUser(
    context: PersistContext,
  ): Record<string, string | boolean | null> {
    const user = context.user;
    if (!user) throw new CollabAccessError(context.accessRevision);
    if (user.isAnonymous === true) {
      return {
        name: user.name || getAnonymousName(user.id),
        color: getStableColor(user.id),
        avatar: null,
        emoji: getAnimalEmoji(user.id),
        isAnonymous: true,
      };
    }
    return {
      name: user.name || 'Anonymous',
      color: getStableColor(user.id),
      avatar: user.avatarUrl ?? null,
    };
  }

  function validateAwarenessIdentity(
    update: Uint8Array,
    document: Document,
    connection: Connection,
    context: PersistContext,
  ): void {
    const entries = parseAwarenessEntries(update);
    if (entries.length === 0)
      throw new CollabProtocolDeniedError('One awareness identity required');
    const ownedClientIds = document.getClients(connection.webSocket);
    const isCanonicalRelay = entries.every((entry) => {
      const ownsClientId =
        context.awarenessClientId === entry.clientId || ownedClientIds.has(entry.clientId);
      if (ownsClientId) return false;
      const canonicalClock = document.awareness.meta.get(entry.clientId)?.clock;
      const canonicalState = document.awareness.getStates().get(entry.clientId);
      return (
        canonicalClock === entry.clock &&
        (entry.state === null
          ? canonicalState === undefined
          : canonicalState !== undefined && isExactJsonValue(entry.state, canonicalState))
      );
    });
    const isKnownServerRelay = entries.every((entry) => {
      const ownsClientId =
        context.awarenessClientId === entry.clientId || ownedClientIds.has(entry.clientId);
      return (
        !ownsClientId &&
        context.sentAwarenessRelayFingerprints?.has(getAwarenessEntryFingerprint(entry)) === true
      );
    });

    // HocuspocusProvider re-emits awareness updates that it just received from
    // the server, and an initial sync can bundle several foreign clients in one
    // message. Accept only an all-foreign no-op relay that is either canonical
    // now or exactly matches an entry this connection was previously sent,
    // then suppress physical application. Mixed, changed, or self-owned input
    // is rejected below.
    if (isCanonicalRelay || isKnownServerRelay) {
      relayedAwarenessMessages.add(update);
      return;
    }

    if (entries.length !== 1)
      throw new CollabProtocolDeniedError('One awareness identity required');
    const entry = entries[0];
    if (!entry) throw new CollabProtocolDeniedError('One awareness identity required');
    const directlyOwnsClientId =
      context.awarenessClientId === entry.clientId || ownedClientIds.has(entry.clientId);
    const otherOwners = document.getConnections().filter((otherConnection) => {
      if (otherConnection === connection) return false;
      const otherContext = otherConnection.context as PersistContext | undefined;
      return (
        otherContext?.awarenessClientId === entry.clientId ||
        document.getClients(otherConnection.webSocket).has(entry.clientId)
      );
    });
    const isSamePrincipal = (otherConnection: Connection): boolean => {
      const otherContext = otherConnection.context as PersistContext | undefined;
      return (
        context.user?.id !== undefined &&
        otherContext?.user?.id === context.user.id &&
        (otherContext.user.isAnonymous === true) === (context.user.isAnonymous === true)
      );
    };
    const compatibleOwner = otherOwners.some(isSamePrincipal);
    const foreignOwner = otherOwners.some((otherConnection) => !isSamePrincipal(otherConnection));
    const ownsClientId = directlyOwnsClientId || compatibleOwner;

    if (entry.state === null) {
      // A not-yet-bound duplicate may not remove another connection's state,
      // even when both connections authenticate as the same principal.
      if (!directlyOwnsClientId || foreignOwner) {
        throw new CollabProtocolDeniedError('Foreign awareness identity is not allowed');
      }
      return;
    }

    if (
      foreignOwner ||
      (context.awarenessClientId !== undefined && context.awarenessClientId !== entry.clientId) ||
      (ownedClientIds.size > 0 && !ownedClientIds.has(entry.clientId)) ||
      (!ownsClientId && document.awareness.getStates().has(entry.clientId))
    ) {
      throw new CollabProtocolDeniedError('Foreign awareness identity is not allowed');
    }

    if (isUnknownRecord(entry.state) && entry.state.user != null) {
      if (!hasExactPrimitiveFields(entry.state.user, getCanonicalAwarenessUser(context))) {
        throw new CollabProtocolDeniedError('Forged awareness user is not allowed');
      }
    }

    context.awarenessClientId = entry.clientId;
  }

  function currentEffectivePermission(context: PersistContext): EffectivePermission | null {
    const permission = context.permission;
    return permission === 'admin' || permission === 'edit' || permission === 'view'
      ? permission
      : null;
  }

  function applyPagePermissionState(
    context: PersistContext,
    connection: { readOnly: boolean } | undefined,
    incoming: { permission: EffectivePermission | null; accessRevision: string },
  ): boolean {
    const current = context.accessRevision
      ? {
          permission: currentEffectivePermission(context),
          accessRevision: context.accessRevision,
        }
      : null;
    if (!shouldApplyPermissionSnapshot(current, incoming)) return false;
    context.permission = incoming.permission;
    context.accessRevision = incoming.accessRevision;
    if (connection) {
      connection.readOnly = incoming.permission === 'view' || incoming.permission === null;
    }
    return true;
  }

  async function assertPageAccess(
    documentName: string,
    userId: string,
    executor: PermissionQueryExecutor = pool,
    sessionToken?: string,
  ): Promise<{ permission: EffectivePermission; accessRevision: string }> {
    const accessResult = await runPermissionQuery(() =>
      executor.query<{
        page_exists: boolean;
        permission: string | null;
        access_revision: string;
        session_valid: boolean;
      }>(
        `select
           exists(select 1 from pages where id = $1 and is_deleted = false) as page_exists,
           (
             select permission
          from get_effective_page_permission($1, $2)
             limit 1
           ) as permission,
           get_page_access_revision($1)::text as access_revision,
           ($3::text is null or exists (
              select 1
              from sessions
              where token = $3 and user_id = $2 and expires_at > statement_timestamp()
            )) as session_valid`,
        [documentName, userId, sessionToken ?? null],
      ),
    );
    const accessRow = accessResult.rows[0];
    if (!accessRow) {
      throw new CollabVerificationError('Missing access row');
    }
    if (!accessRow.session_valid) {
      logger.debug(`[auth] user=${userId} has an invalid/expired session`);
      throw new CollabAccessError(accessRow.access_revision);
    }
    if (!accessRow.page_exists) {
      logger.debug(`[auth] page=${documentName} not found`);
      throw new CollabAccessError(accessRow.access_revision);
    }

    const rawPermission = accessRow.permission;
    if (rawPermission !== 'view' && rawPermission !== 'edit' && rawPermission !== 'admin') {
      logger.debug(
        `[auth] user=${userId} denied access to page=${documentName} (invalid permission)`,
      );
      throw new CollabAccessError(accessRow.access_revision);
    }
    return { permission: rawPermission, accessRevision: accessRow.access_revision };
  }

  async function assertMetaRoomAccess(userId: string, roomUserId: string): Promise<void> {
    if (userId !== roomUserId) {
      logger.debug(`[auth] user=${userId} denied access to meta room for user=${roomUserId}`);
      throw new CollabAccessError();
    }
  }

  async function assertAnonymousPageAccess(
    documentName: string,
    executor: PermissionQueryExecutor = pool,
  ): Promise<{ permission: EffectivePermission; accessRevision: string }> {
    const shareResult = await runPermissionQuery(() =>
      executor.query<{ permission: string | null; access_revision: string }>(
        `SELECT get_public_page_permission($1) AS permission,
                get_page_access_revision($1)::text AS access_revision`,
        [documentName],
      ),
    );
    const rawPermission = shareResult.rows[0]?.permission;
    const accessRevision = shareResult.rows[0]?.access_revision;
    if (rawPermission !== 'view' && rawPermission !== 'edit' && rawPermission !== 'admin') {
      logger.debug(`[auth] anonymous denied: page ${documentName} is restricted`);
      throw new CollabAccessError(accessRevision);
    }
    if (!accessRevision) throw new CollabVerificationError('Missing access revision');
    return { permission: rawPermission, accessRevision };
  }

  async function lockDocumentAccessMutation(
    documentName: string,
    executor: PermissionQueryExecutor,
  ): Promise<void> {
    const ownerResult = await runPermissionQuery(() =>
      executor.query(
        `SELECT COALESCE(get_root_folder_owner(p.parent_id), p.created_by) AS owner_id
         FROM pages p
         WHERE p.id = $1 AND p.is_deleted = false`,
        [documentName],
      ),
    );
    const ownerId = ownerResult.rows[0]?.owner_id as string | null | undefined;
    if (!ownerId) return;

    await runPermissionQuery(() =>
      executor.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `workspace-access:${ownerId}`,
      ]),
    );
  }

  async function lockActivePage(
    documentName: string,
    executor: PermissionQueryExecutor,
  ): Promise<string> {
    const result = await runPermissionQuery(() =>
      executor.query<{ title_revision: string }>(
        `select title_revision::text as title_revision
         from pages
         where id = $1 and is_deleted = false
         for update`,
        [documentName],
      ),
    );
    if (result.rows.length === 0) throw new CollabAccessError();
    const titleRevision = result.rows[0]?.title_revision;
    if (!titleRevision) throw new CollabVerificationError('Missing page title revision');
    return titleRevision;
  }

  function updateRevalidatedConnections(
    documentName: string,
    user: { id: string; isAnonymous?: boolean },
    permission: EffectivePermission | null,
    accessRevision: string,
  ): void {
    const activeDoc = server.hocuspocus.documents.get(documentName) as Document | undefined;
    if (!activeDoc) return;

    for (const connection of activeDoc.getConnections()) {
      const connectionContext = connection.context as
        | {
            user?: { id: string; isAnonymous?: boolean };
            permission?: unknown;
            accessRevision?: string;
          }
        | undefined;
      if (
        connectionContext?.user?.id !== user.id ||
        connectionContext.user.isAnonymous !== user.isAnonymous
      ) {
        continue;
      }
      const previousPermission = connectionContext.permission;
      const previousReadOnly = connection.readOnly;
      if (
        !applyPagePermissionState(connectionContext as PersistContext, connection, {
          permission,
          accessRevision,
        })
      ) {
        continue;
      }
      sendPermissionSnapshot(connection, permission, accessRevision);
      if (!permission) {
        connection.sendStateless(
          JSON.stringify({ type: 'share_event', action: 'revoke' } satisfies StatelessShareMessage),
        );
        connection.close({ code: 4401, reason: COLLAB_TERMINAL_REASONS.ACCESS_REVOKED });
        continue;
      }

      const readOnly = permission === 'view';
      if (previousReadOnly === readOnly && previousPermission === permission) continue;
      connection.sendStateless(
        JSON.stringify({
          type: 'share_event',
          action: 'update',
          permission,
        } satisfies StatelessShareMessage),
      );
    }
  }

  function blockDocumentForReload(documentName: string, code: number, reason: string): void {
    if (blockedDocuments.has(documentName)) return;

    blockedDocuments.add(documentName);
    pendingWriters.delete(documentName);
    documentChangeVersions.delete(documentName);
    documentSizeEstimates.delete(documentName);
    const activeDocument = server.hocuspocus.documents.get(documentName) as Document | undefined;
    for (const connection of activeDocument?.getConnections() ?? []) {
      connection.close({ code, reason });
    }
  }

  function blockOversizedDocument(documentName: string, size: number): void {
    logger.warn(
      `[size] blocked page=${documentName}: encoded document is ${size} bytes (limit ${maxDocumentBytes})`,
    );
    blockDocumentForReload(documentName, 1009, 'Document size limit exceeded');
  }

  function ensureTitleWithinLimit(documentName: string, document: Y.Doc): boolean {
    if (!document.share.has('title')) return true;
    const titleText = document.getText('title');
    const title = titleText.toString();
    const titleLength = getUnicodeCodePointLength(title);
    if (titleLength <= MAX_PAGE_TITLE_LENGTH) {
      // Replacing a Y.Text normally arrives as a delete followed by an insert.
      // Keep the previous title through that transient empty state so an
      // oversized insert can be reverted to the actual last valid value.
      if (title.length > 0) acceptedPageTitles.set(documentName, title);
      return true;
    }

    const acceptedTitle = acceptedPageTitles.get(documentName);
    // Existing titles can predate this boundary or originate from import
    // workflows. Preserve that canonical value while rejecting new oversized
    // collaborative replacements.
    if (acceptedTitle === title) return true;
    if (acceptedTitle === undefined) {
      logger.error(`[title] cannot recover page=${documentName}: no canonical title is available`);
      blockDocumentForReload(documentName, 4500, 'Document reload required');
      return false;
    }

    // A Yjs update cannot be removed by reconnecting because clients retain
    // and resend their local CRDT state. Apply a compensating update instead;
    // it reaches every client and keeps the rejected title out of persistence.
    document.transact(() => {
      titleText.delete(0, titleText.length);
      titleText.insert(0, acceptedTitle);
    });
    logger.warn(
      `[title] rejected page=${documentName}: title is ${titleLength} characters (limit ${MAX_PAGE_TITLE_LENGTH})`,
    );
    return true;
  }

  async function canPersistDocument(
    documentName: string,
    context: PersistContext | undefined,
    executor: PermissionQueryExecutor = pool,
  ): Promise<boolean> {
    if (!context?.user) return false;

    try {
      const access = context.user.isAnonymous
        ? await assertAnonymousPageAccess(documentName, executor)
        : await assertPageAccess(documentName, context.user.id, executor, context.sessionToken);
      applyPagePermissionState(context, undefined, access);
      updateRevalidatedConnections(
        documentName,
        context.user,
        access.permission,
        access.accessRevision,
      );
      const effectivePermission = currentEffectivePermission(context);
      if (effectivePermission !== 'edit' && effectivePermission !== 'admin') {
        logger.warn(
          `[persist] permission is not writable for user=${context.user.id} on page=${documentName}, skipping persist`,
        );
        return false;
      }
      return true;
    } catch (error) {
      if (error instanceof CollabAccessError) {
        if (error.accessRevision) {
          applyPagePermissionState(context, undefined, {
            permission: null,
            accessRevision: error.accessRevision,
          });
          updateRevalidatedConnections(documentName, context.user, null, error.accessRevision);
        }
        logger.warn(
          `[persist] access revoked for user=${context.user.id} on page=${documentName}, skipping persist`,
        );
        return false;
      }
      throw error;
    }
  }

  async function canPersistPendingDocument(
    documentName: string,
    fallbackContext: PersistContext | undefined,
    executor?: PermissionQueryExecutor,
    maximumWriterVersion = Number.POSITIVE_INFINITY,
  ): Promise<boolean> {
    if (blockedDocuments.has(documentName)) return false;

    try {
      if (executor) await lockDocumentAccessMutation(documentName, executor);
      if (blockedDocuments.has(documentName)) return false;
      const writers = Array.from(pendingWriters.get(documentName)?.values() ?? []).filter(
        (writer) => writer.version <= maximumWriterVersion,
      );
      if (writers.length === 0 && fallbackContext) {
        writers.push({ context: fallbackContext, version: maximumWriterVersion });
      }
      if (writers.length === 0) return false;

      for (const writer of writers) {
        // Production writes are admitted under the same workspace advisory
        // lock used by permission mutations. A later downgrade must not erase
        // an edit that linearized before it.
        if (writer.admittedAccessRevision) continue;
        const canPersist = await canPersistDocument(documentName, writer.context, executor ?? pool);
        if (canPersist) continue;

        // The in-memory Y.Doc may already contain this writer's rejected update.
        // Disconnect the affected room so Hocuspocus unloads it and reloads the
        // last persisted state rather than saving a mixed-author update later.
        // Only the rejected writer receives a revoke/update event from the
        // targeted revalidation above. Other collaborators need a clean room
        // reload, not a false access-revocation notification.
        blockDocumentForReload(documentName, 4500, 'Document reload required');
        return false;
      }
      return true;
    } catch (error) {
      if (error instanceof CollabVerificationError) {
        logger.warn(
          `[persist] blocking page=${documentName} after permission verification failed: ${error.originalError}`,
        );
        blockDocumentForReload(
          documentName,
          4500,
          COLLAB_TERMINAL_REASONS.PERMISSION_VERIFICATION_FAILED,
        );
        return false;
      }

      logger.error(
        `[persist] unexpected permission revalidation failure for page=${documentName}: ${error}`,
      );
      try {
        blockDocumentForReload(
          documentName,
          4500,
          COLLAB_TERMINAL_REASONS.PERMISSION_VERIFICATION_FAILED,
        );
      } catch (blockError) {
        logger.error(
          `[persist] failed to block page=${documentName} after unexpected error: ${blockError}`,
        );
      }
      throw error;
    }
  }

  function getConnectionResolutionPrincipals(
    documentName: string,
    fallbackContext: PersistContext | undefined,
    maximumWriterVersion: number,
  ): ConnectionResolutionPrincipal[] {
    const contexts = Array.from(pendingWriters.get(documentName)?.values() ?? [])
      .filter((writer) => writer.version <= maximumWriterVersion)
      .map((writer) => writer.context);
    if (contexts.length === 0 && fallbackContext) contexts.push(fallbackContext);

    const principals = new Map<string, ConnectionResolutionPrincipal>();
    for (const writerContext of contexts) {
      const writer = writerContext.user;
      if (!writer) continue;
      const principal = {
        userId: writer.id,
        isAnonymous: writer.isAnonymous === true,
      };
      principals.set(
        `${principal.isAnonymous ? 'anonymous' : 'user'}:${principal.userId}`,
        principal,
      );
    }
    return [...principals.values()];
  }

  function clearPersistedWriters(documentName: string, maximumWriterVersion: number): void {
    const writers = pendingWriters.get(documentName);
    if (!writers) return;
    for (const [key, writer] of writers) {
      if (writer.version <= maximumWriterVersion) writers.delete(key);
    }
    if (writers.size === 0) pendingWriters.delete(documentName);
  }

  async function handleGrantReceived(payload: {
    entityType: string;
    entityId: string;
    entityTitle: string;
    sharedByName: string;
    targetUserId: string;
    permission?: SharePermission;
    message?: string;
  }): Promise<void> {
    if (!server.hocuspocus?.documents) {
      logger.debug('[grant] no active documents, skipping');
      return;
    }

    if (
      (payload.entityType !== 'page' && payload.entityType !== 'folder') ||
      (payload.permission !== 'view' &&
        payload.permission !== 'edit' &&
        payload.permission !== 'admin')
    ) {
      logger.debug('[grant] malformed grant payload, skipping');
      return;
    }

    const canonicalGrant = await pool.query<{
      entity_title: string;
      shared_by_name: string;
    }>(
      `select case when s.entity_type = 'page' then p.title else f.name end as entity_title,
              coalesce(sharer.name, 'Someone') as shared_by_name
       from shares s
       join users sharer on sharer.id = s.shared_by
       left join pages p
         on s.entity_type = 'page' and p.id = s.entity_id and p.is_deleted = false
       left join folders f
         on s.entity_type = 'folder' and f.id = s.entity_id and f.is_deleted = false
       where s.entity_type = $1
         and s.entity_id = $2
         and s.recipient_user_id = $3
         and s.permission = $4
         and ((s.entity_type = 'page' and p.id is not null)
           or (s.entity_type = 'folder' and f.id is not null))
       limit 1`,
      [payload.entityType, payload.entityId, payload.targetUserId, payload.permission],
    );
    const grant = canonicalGrant.rows[0];
    if (!grant) {
      logger.debug(
        `[grant] stale grant ignored for user=${payload.targetUserId} entity=${payload.entityType}:${payload.entityId}`,
      );
      return;
    }

    const grantMessage = JSON.stringify({
      type: 'grant_received',
      entityType: payload.entityType,
      entityId: payload.entityId,
      entityTitle: grant.entity_title,
      sharedByName: grant.shared_by_name,
      ...(payload.message !== undefined && { message: payload.message }),
      refreshViaAccessVersion: true,
    });
    let affectedCount = 0;
    const metaDocument = server.hocuspocus.documents.get(`page-meta:${payload.targetUserId}`) as
      | Document
      | undefined;
    for (const connection of metaDocument?.getConnections() ?? []) {
      connection.sendStateless(grantMessage);
      affectedCount++;
    }

    // The meta room is the normal global notification channel. During initial
    // application startup it may not be connected yet, so retain an active
    // page connection as a fallback instead of dropping the grant event.
    if (affectedCount === 0) {
      for (const [documentName, doc] of server.hocuspocus.documents) {
        if (documentName.startsWith(META_ROOM_PREFIX)) continue;
        const activeDoc = doc as Document | undefined;
        if (!activeDoc) continue;
        for (const connection of activeDoc.getConnections()) {
          const ctx = connection.context as
            | { user?: { id: string; isAnonymous?: boolean } }
            | undefined;
          if (!ctx?.user || ctx.user.id !== payload.targetUserId) continue;
          connection.sendStateless(grantMessage);
          affectedCount++;
        }
      }
    }

    logger.info(
      `[grant] sent grant_received to ${affectedCount} connection(s) for user=${payload.targetUserId}`,
    );
  }

  const server = new Server({
    port,
    debounce: debounceMs,
    maxDebounce: maxDebounceMs,
    onAuthenticate: async ({ token, requestHeaders, documentName, connectionConfig }) => {
      if (documentName && blockedDocuments.has(documentName)) {
        throw new CollabAccessError();
      }
      const cookies = parseCookies(requestHeaders.cookie);
      const bearerTokenHeader = requestHeaders.authorization;
      const bearerMatch = bearerTokenHeader?.match(/^Bearer\s+(.+)$/i);
      const bearerToken = bearerMatch?.[1]?.trim() ?? '';
      const tokenFromParam = token?.trim() ?? '';
      const tokenFromCookie =
        cookies.get('better-auth.session_token')?.trim() ||
        cookies.get('__Secure-better-auth.session_token')?.trim() ||
        '';
      const sessionToken = tokenFromParam || bearerToken || tokenFromCookie || '';

      if (!sessionToken) {
        logger.debug('[auth] no session token provided');
        throw new Error('Unauthorized');
      }

      if (sessionToken.startsWith('anon:')) {
        const anonymousId = sessionToken.slice(5);
        if (!UUID_REGEX.test(anonymousId)) {
          logger.debug('[auth] anonymous token requires a valid UUID identity');
          throw new Error('Forbidden');
        }
        if (!documentName || !UUID_REGEX.test(documentName)) {
          logger.debug('[auth] anonymous token requires valid document name');
          throw new Error('Forbidden');
        }

        const { permission, accessRevision } = await assertAnonymousPageAccess(documentName);
        const anonymousName = getAnonymousName(anonymousId);
        await pool.query(
          `insert into guest_identities (id, name, created_at, last_seen_at)
           values ($1, $2, now(), now())
           on conflict (id) do update set last_seen_at = excluded.last_seen_at`,
          [anonymousId, anonymousName],
        );

        if (permission === 'view') {
          connectionConfig.readOnly = true;
        }

        logger.info(
          `[auth] anonymous user=${anonymousId} connected to page=${documentName} (permission=${permission})`,
        );
        return {
          user: {
            id: anonymousId,
            name: anonymousName,
            isAnonymous: true,
          },
          permission,
          accessRevision,
          sessionToken,
          deferInitialAwareness: true,
          establishmentGate: createEstablishmentGate(),
        };
      }

      const result = await pool.query(
        `select users.id, users.email, users.name,
                users.image as "avatarUrl",
                coalesce((select max(version) from workspace_access_versions), 0)::text as "accessRevision"
         from sessions
         join users on users.id = sessions.user_id
         where sessions.token = $1 and sessions.expires_at > statement_timestamp()
         limit 1`,
        [sessionToken],
      );

      const user = result.rows[0] as
        | {
            id: string;
            email: string;
            name: string;
            avatarUrl: string | null;
            accessRevision: string;
          }
        | undefined;
      if (!user) {
        logger.debug('[auth] invalid/expired session');
        throw new Error('Unauthorized');
      }

      let permission: EffectivePermission | null = null;
      let accessRevision = user.accessRevision;

      if (documentName) {
        if (isMetaRoom(documentName)) {
          const roomUserId = documentName.slice(META_ROOM_PREFIX.length);
          if (!UUID_REGEX.test(roomUserId)) throw new CollabAccessError(accessRevision);
          await assertMetaRoomAccess(user.id, roomUserId);
          connectionConfig.readOnly = true;
        } else {
          if (!UUID_REGEX.test(documentName)) throw new CollabAccessError(accessRevision);
          const access = await assertPageAccess(documentName, user.id, pool, sessionToken);
          permission = access.permission;
          accessRevision = access.accessRevision;
        }
      } else {
        throw new CollabAccessError(accessRevision);
      }

      if (permission === 'view') {
        connectionConfig.readOnly = true;
      }

      logger.info(`[auth] authenticated user=${user.id} (${user.email}) permission=${permission}`);
      return {
        user,
        permission,
        accessRevision,
        sessionToken,
        deferInitialAwareness: true,
        establishmentGate: createEstablishmentGate(),
      } satisfies PersistContext;
    },
    connected: async ({ connection, context, documentName }) => {
      const connectionContext = context as PersistContext | undefined;
      if (!connectionContext?.accessRevision || !connectionContext.user) {
        connection.close({
          code: 4500,
          reason: COLLAB_TERMINAL_REASONS.PERMISSION_VERIFICATION_FAILED,
        });
        return;
      }
      if (connectionContext.establishmentGate?.state === 'rejected') return;
      const connectionUser = connectionContext.user;
      await withSerializedPermissionCheck(connectionContext, async () => {
        try {
          if (isMetaRoom(documentName)) {
            const sessionResult = await pool.query<{
              valid: boolean;
              access_revision: string;
            }>(
              `select exists (
                 select 1 from sessions
                 where token = $1 and user_id = $2 and expires_at > statement_timestamp()
               ) as valid,
               coalesce((select max(version) from workspace_access_versions), 0)::text as access_revision`,
              [connectionContext.sessionToken, connectionUser.id],
            );
            const sessionState = sessionResult.rows[0];
            if (!sessionState) throw new CollabVerificationError('Missing session state');
            connectionContext.accessRevision = sessionState.access_revision;
            connectionContext.permission = null;
            if (!sessionState.valid) {
              rejectConnectionTraffic(connectionContext);
              connection.close({ code: 4401, reason: COLLAB_TERMINAL_REASONS.SESSION_EXPIRED });
              return;
            }
            if (!releaseConnectionTraffic(connectionContext)) return;
            sendPermissionSnapshot(connection, null, sessionState.access_revision);
            sendDeferredInitialAwareness(connection as Connection);
            return;
          }

          const access = connectionUser.isAnonymous
            ? await assertAnonymousPageAccess(documentName)
            : await assertPageAccess(
                documentName,
                connectionUser.id,
                pool,
                connectionContext.sessionToken,
              );
          applyPagePermissionState(connectionContext, connection, access);
          const effectivePermission = currentEffectivePermission(connectionContext);
          if (!effectivePermission) {
            rejectConnectionTraffic(connectionContext);
            connection.close({ code: 4401, reason: COLLAB_TERMINAL_REASONS.ACCESS_REVOKED });
            return;
          }
          if (!releaseConnectionTraffic(connectionContext)) return;
          sendPermissionSnapshot(
            connection,
            effectivePermission,
            connectionContext.accessRevision ?? access.accessRevision,
          );
          sendDeferredInitialAwareness(connection as Connection);
        } catch (error) {
          if (error instanceof CollabAccessError && error.accessRevision) {
            const applied = applyPagePermissionState(connectionContext, connection, {
              permission: null,
              accessRevision: error.accessRevision,
            });
            const effectivePermission = currentEffectivePermission(connectionContext);
            if (!applied && effectivePermission && releaseConnectionTraffic(connectionContext)) {
              sendPermissionSnapshot(
                connection,
                effectivePermission,
                connectionContext.accessRevision ?? error.accessRevision,
              );
              sendDeferredInitialAwareness(connection as Connection);
              return;
            }
            rejectConnectionTraffic(connectionContext);
            connection.close({ code: 4401, reason: COLLAB_TERMINAL_REASONS.ACCESS_REVOKED });
            return;
          }
          rejectConnectionTraffic(connectionContext);
          connection.close({
            code: 4500,
            reason: COLLAB_TERMINAL_REASONS.PERMISSION_VERIFICATION_FAILED,
          });
        }
      });
    },
    beforeHandleMessage: async ({ documentName, document, update, connection, context }) => {
      const connectionContext = context as PersistContext | undefined;
      const protocolMessageType = getProtocolMessageType(update);
      // Stateless application messages are server-to-client only. In
      // particular, Hocuspocus BroadcastStateless would otherwise let any
      // authenticated client forge permission/share notifications to peers.
      if (protocolMessageType === 5 || protocolMessageType === 6) {
        if (connectionContext) rejectConnectionTraffic(connectionContext);
        connection.close({ code: 4403, reason: 'Client stateless messages are not allowed' });
        throw new CollabProtocolDeniedError();
      }
      if (!connectionContext) throw new Error('Unauthorized');
      if (!(await waitForConnectionTraffic(connectionContext, connection))) {
        throw new CollabAccessError(connectionContext.accessRevision);
      }

      const isSyncMessage = protocolMessageType === 0 || protocolMessageType === 4;
      const isAwarenessMessage = protocolMessageType === 1 || protocolMessageType === 3;
      if (protocolMessageType === 1) {
        try {
          validateAwarenessIdentity(
            update,
            document as Document,
            connection as Connection,
            connectionContext,
          );
        } catch (error) {
          rejectConnectionTraffic(connectionContext);
          const reason = error instanceof Error ? error.message : 'Invalid awareness identity';
          connection.close({ code: 4403, reason });
          throw error;
        }
      }
      const writeUpdate = getYjsWriteUpdate(update);
      if (isMetaRoom(documentName)) {
        const metaContext = connectionContext;
        if (!isSyncMessage && !isAwarenessMessage) return;
        if (!metaContext?.user || !metaContext.sessionToken) throw new Error('Unauthorized');
        await withSerializedPermissionCheck(metaContext, async () => {
          const sessionResult = await pool.query<{ valid: boolean; access_revision: string }>(
            `select exists (
               select 1 from sessions
               where token = $1 and user_id = $2 and expires_at > statement_timestamp()
             ) as valid,
             coalesce((select max(version) from workspace_access_versions), 0)::text as access_revision`,
            [metaContext.sessionToken, metaContext.user?.id],
          );
          const sessionState = sessionResult.rows[0];
          if (!sessionState) throw new CollabVerificationError('Missing session state');
          metaContext.accessRevision = sessionState.access_revision;
          if (sessionState.valid) return;
          sendPermissionSnapshot(connection, null, sessionState.access_revision);
          connection.close({ code: 4401, reason: COLLAB_TERMINAL_REASONS.SESSION_EXPIRED });
          throw new CollabAccessError(sessionState.access_revision);
        });
        return;
      }
      if (writeUpdate && yjsUpdateIntroducesWikiLinkTargetIds(document as Document, writeUpdate)) {
        // Authored path/label text is page content. A structured target UUID is
        // different: it is hidden entity metadata, and a canonical page room
        // cannot safely personalize it for each reader.
        rejectConnectionTraffic(connectionContext);
        connection.close({ code: 4403, reason: 'Wiki-link target IDs are not allowed' });
        throw new CollabProtocolDeniedError('Wiki-link target IDs are not allowed');
      }
      const writer = connectionContext;
      if (!isSyncMessage && !isAwarenessMessage && !writeUpdate) return;
      if (!writer?.user) throw new Error('Unauthorized');
      const writerUser = writer.user;
      await withSerializedPermissionCheck(writer, async () => {
        // A single connection must not start another permission transaction
        // until its previous admitted update has physically applied and
        // released the workspace/page fence.
        await writer.applicationCheck?.catch(() => undefined);
        const client = await pool.connect();
        let titleRevision: string | undefined;
        let transactionOpen = false;
        let clientTransferredToApplication = false;
        const touchesTitle = writeUpdate
          ? yjsUpdateTouchesTitle(document as Document, writeUpdate)
          : false;
        const recordWriteAdmission = (accessRevision: string): WriteAdmission | undefined => {
          if (!writeUpdate || !titleRevision) return undefined;
          const pending = writer.pendingWriteAdmissions ?? [];
          if (pending.length >= 64) {
            throw new CollabProtocolDeniedError('Too many writes awaiting application');
          }
          const admission = { accessRevision, titleRevision, touchesTitle };
          pending.push(admission);
          writer.pendingWriteAdmissions = pending;
          return admission;
        };
        const retainTransactionThroughApplication = (admission: WriteAdmission): boolean => {
          // Hook-level tests use lightweight connection doubles and explicitly
          // invoke apply/onChange. Production WebSocket traffic always uses a
          // real Hocuspocus Connection and receives the held transaction.
          if (!(connection instanceof Connection)) return false;

          const previousTitleBaseline = pendingTitleBaselines.get(documentName);
          if (admission.touchesTitle) {
            pendingTitleBaselines.set(documentName, admission.titleRevision);
          }
          beginApplicationCheck(writer);
          let settled = false;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const fence: ApplicationFence = {
            admission,
            context: writer,
            async complete(applied, changed = applied) {
              if (settled) return;
              settled = true;
              if (!applied) expiredApplicationMessages.add(update);
              if (timeout) clearTimeout(timeout);
              applicationFencesByMessage.delete(update);
              activeApplicationFences.delete(fence);
              let committed = false;
              try {
                await client.query(applied ? 'COMMIT' : 'ROLLBACK');
                transactionOpen = false;
                committed = applied;
              } catch (error) {
                await client.query('ROLLBACK').catch(() => undefined);
                transactionOpen = false;
                blockDocumentForReload(documentName, 4500, 'Write application commit failed');
                throw error;
              } finally {
                if (admission.touchesTitle && (!committed || !changed)) {
                  if (pendingTitleBaselines.get(documentName) === admission.titleRevision) {
                    if (previousTitleBaseline === undefined) {
                      pendingTitleBaselines.delete(documentName);
                    } else {
                      pendingTitleBaselines.set(documentName, previousTitleBaseline);
                    }
                  }
                }
                client.release();
                finishApplicationCheck(writer);
              }
            },
          };
          applicationFencesByMessage.set(update, fence);
          activeApplicationFences.add(fence);
          clientTransferredToApplication = true;
          timeout = setTimeout(() => {
            removePendingWriteAdmission(writer, admission);
            void fence
              .complete(false, false)
              .catch(() => undefined)
              .finally(() => {
                connection.close({ code: 4500, reason: 'Write application timed out' });
              });
          }, applicationFenceTimeoutMs);
          timeout.unref();
          return true;
        };
        try {
          await client.query('BEGIN');
          transactionOpen = true;
          await lockDocumentAccessMutation(documentName, client);
          titleRevision = await lockActivePage(documentName, client);
          const access = writerUser.isAnonymous
            ? await assertAnonymousPageAccess(documentName, client)
            : await assertPageAccess(documentName, writerUser.id, client, writer.sessionToken);
          const previousPermission = currentEffectivePermission(writer);
          const stateApplied = applyPagePermissionState(writer, connection, access);
          const effectivePermission = currentEffectivePermission(writer);
          if (writeUpdate && effectivePermission !== 'edit' && effectivePermission !== 'admin') {
            await client.query('ROLLBACK');
            sendPermissionSnapshot(
              connection,
              effectivePermission,
              writer.accessRevision ?? access.accessRevision,
            );
            if (stateApplied && previousPermission !== effectivePermission && effectivePermission) {
              connection.sendStateless(
                JSON.stringify({
                  type: 'share_event',
                  action: 'update',
                  permission: effectivePermission,
                } satisfies StatelessShareMessage),
              );
            }
            connection.close({ code: 4403, reason: 'Write permission required' });
            throw new CollabWriteDeniedError();
          }
          const admittedAccessRevision = writer.accessRevision ?? access.accessRevision;
          const admission = recordWriteAdmission(admittedAccessRevision);
          if (admission && retainTransactionThroughApplication(admission)) {
            transactionOpen = false;
          } else {
            await client.query('COMMIT');
            transactionOpen = false;
          }
          if (stateApplied && previousPermission !== effectivePermission && effectivePermission) {
            sendPermissionSnapshot(
              connection,
              effectivePermission,
              writer.accessRevision ?? access.accessRevision,
            );
            connection.sendStateless(
              JSON.stringify({
                type: 'share_event',
                action: 'update',
                permission: effectivePermission,
              } satisfies StatelessShareMessage),
            );
          }
        } catch (error) {
          if (error instanceof CollabWriteDeniedError) {
            if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
            transactionOpen = false;
            throw error;
          }
          if (error instanceof CollabAccessError) {
            if (error.accessRevision) {
              const applied = applyPagePermissionState(writer, connection, {
                permission: null,
                accessRevision: error.accessRevision,
              });
              const retainedPermission = currentEffectivePermission(writer);
              const canRetainWrite =
                !writeUpdate || retainedPermission === 'edit' || retainedPermission === 'admin';
              if (!applied && retainedPermission && canRetainWrite) {
                const admission = writer.accessRevision
                  ? recordWriteAdmission(writer.accessRevision)
                  : undefined;
                if (admission && retainTransactionThroughApplication(admission)) {
                  transactionOpen = false;
                } else {
                  await client.query('COMMIT');
                  transactionOpen = false;
                }
                return;
              }
              sendPermissionSnapshot(connection, null, error.accessRevision);
            }
            if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
            transactionOpen = false;
            connection.sendStateless(
              JSON.stringify({
                type: 'share_event',
                action: 'revoke',
              } satisfies StatelessShareMessage),
            );
            connection.close({ code: 4401, reason: COLLAB_TERMINAL_REASONS.ACCESS_REVOKED });
            throw error;
          }
          if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
          transactionOpen = false;
          connection.close({
            code: 4500,
            reason: COLLAB_TERMINAL_REASONS.PERMISSION_VERIFICATION_FAILED,
          });
          throw error;
        } finally {
          if (!clientTransferredToApplication) client.release();
        }
      });
    },
    onLoadDocument: async ({ documentName, document, context, connectionConfig }) => {
      blockedDocuments.delete(documentName);
      pendingWriters.delete(documentName);
      documentChangeVersions.delete(documentName);
      documentSizeEstimates.delete(documentName);
      acceptedPageTitles.delete(documentName);
      canonicalPageTitles.delete(documentName);
      pendingTitleBaselines.delete(documentName);
      const loadContext = context as PersistContext | undefined;
      const contextUser = loadContext?.user;
      if (!contextUser) throw new Error('Unauthorized');

      if (isMetaRoom(documentName)) {
        const userId = documentName.slice(META_ROOM_PREFIX.length);
        await assertMetaRoomAccess(contextUser.id, userId);
        if (loadContext.sessionToken) {
          const sessionResult = await pool.query<{ valid: boolean; access_revision: string }>(
            `select exists (
               select 1 from sessions
               where token = $1 and user_id = $2 and expires_at > statement_timestamp()
             ) as valid,
             coalesce((select max(version) from workspace_access_versions), 0)::text as access_revision`,
            [loadContext.sessionToken, contextUser.id],
          );
          const sessionState = sessionResult.rows[0];
          if (!sessionState) throw new CollabVerificationError('Missing session state');
          loadContext.accessRevision = sessionState.access_revision;
          if (!sessionState.valid) throw new CollabAccessError(sessionState.access_revision);
        }
        logger.debug(`[meta] loading page meta for user: ${userId}`);

        await rebuildPageMetaDocument(pool, userId, document, logger);
        return;
      }

      if (!UUID_REGEX.test(documentName)) {
        logger.debug(`skipping non-meta, non-UUID room: ${documentName}`);
        return undefined;
      }

      const loadClient = await pool.connect();
      let result: QueryResult<{ ydoc: Buffer | null; title: string }>;
      try {
        await loadClient.query('begin');
        await lockDocumentAccessMutation(documentName, loadClient);
        await lockActivePage(documentName, loadClient);
        const access = contextUser.isAnonymous
          ? await assertAnonymousPageAccess(documentName, loadClient)
          : await assertPageAccess(
              documentName,
              contextUser.id,
              loadClient,
              loadContext.sessionToken,
            );
        loadContext.permission = access.permission;
        loadContext.accessRevision = access.accessRevision;
        connectionConfig.readOnly = access.permission === 'view';
        result = await loadClient.query<{ ydoc: Buffer | null; title: string }>(
          'select ydoc, title from pages where id = $1 and is_deleted = false',
          [documentName],
        );
        const storedPage = result.rows[0];
        if (storedPage?.ydoc && storedPage.ydoc.length > 0) {
          const canonicalState = Buffer.from(
            sanitizeCanonicalYjsUpdate(new Uint8Array(storedPage.ydoc)),
          );
          if (!canonicalState.equals(storedPage.ydoc)) {
            // Rewrite under the same page/access locks before any initial sync
            // can expose a legacy UUID-bearing snapshot to this reader.
            await loadClient.query('update pages set ydoc = $1 where id = $2', [
              canonicalState,
              documentName,
            ]);
            storedPage.ydoc = canonicalState;
          }
        }
        await loadClient.query('commit');
      } catch (error) {
        await loadClient.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        loadClient.release();
      }

      if (result.rows.length === 0) {
        throw new CollabAccessError(loadContext.accessRevision);
      }

      const row = result.rows[0] as { ydoc: Buffer | null; title: string } | undefined;
      if (row) {
        const canonicalTitle = row.title || 'Untitled';
        acceptedPageTitles.set(documentName, canonicalTitle);
        canonicalPageTitles.set(documentName, canonicalTitle);
        pendingTitleBaselines.delete(documentName);
      }
      if (!row?.ydoc || row.ydoc.length === 0) {
        documentSizeEstimates.set(documentName, 0);
        return undefined;
      }
      if (row.ydoc.length > maxDocumentBytes) {
        logger.warn(
          `[size] refused to load page=${documentName}: stored document is ${row.ydoc.length} bytes (limit ${maxDocumentBytes})`,
        );
        throw new Error('Document size limit exceeded');
      }

      documentSizeEstimates.set(documentName, row.ydoc.length);
      logger.debug(`Loading document: ${documentName}, size: ${row.ydoc.length} bytes`);
      Y.applyUpdate(document, new Uint8Array(row.ydoc));

      // Reconcile the Yjs title with the SQL title. This handles renames
      // that happened via the PATCH API (sidebar/home) while the page was
      // not open in any editor session — the SQL column was updated, but
      // the Yjs binary still has the old title.
      const yjsTitle = document.getText('title').toString();
      if (yjsTitle !== row.title) {
        document.transact(() => {
          const titleText = document.getText('title');
          titleText.delete(0, titleText.length);
          titleText.insert(0, row.title);
        });
      }
      const loadedSize = Y.encodeStateAsUpdate(document).length;
      if (loadedSize > maxDocumentBytes) {
        logger.warn(
          `[size] refused to load page=${documentName}: reconciled document is ${loadedSize} bytes (limit ${maxDocumentBytes})`,
        );
        throw new Error('Document size limit exceeded');
      }
      documentSizeEstimates.set(documentName, loadedSize);
    },
    onChange: async ({ documentName, context, document, update }) => {
      if (isMetaRoom(documentName) || blockedDocuments.has(documentName)) return;
      const writer = context as PersistContext | undefined;
      const exactAdmission = writeAdmissionsByUpdate.get(update);
      if (exactAdmission) writeAdmissionsByUpdate.delete(update);
      const writeAdmission =
        exactAdmission ?? (writer?.pendingWriteAdmissions?.shift() as WriteAdmission | undefined);
      if (writer?.pendingWriteAdmissions?.length === 0) delete writer.pendingWriteAdmissions;
      if (!ensureTitleWithinLimit(documentName, document)) return;
      if (writeAdmission?.touchesTitle) {
        pendingTitleBaselines.set(documentName, writeAdmission.titleRevision);
      }
      if (!writer?.user) return;
      // A canonical revoke/downgrade may close and mutate the context after the
      // permission hook resolves but before this async onChange hook executes.
      // The immutable per-update admission is proof that this exact update
      // linearized before that mutation and must enter the persistence queue.
      if (!writeAdmission && (writer.permission === 'view' || writer.permission === null)) return;

      const estimatedSize = (documentSizeEstimates.get(documentName) ?? 0) + update.byteLength;
      if (estimatedSize > maxDocumentBytes) {
        const encodedSize = Y.encodeStateAsUpdate(document).length;
        if (encodedSize > maxDocumentBytes) {
          blockOversizedDocument(documentName, encodedSize);
          return;
        }
        documentSizeEstimates.set(documentName, encodedSize);
      } else {
        documentSizeEstimates.set(documentName, estimatedSize);
      }

      const writerKey = `${writer.user.isAnonymous === true ? 'anonymous' : 'user'}:${writer.user.id}:${writer.sessionToken ?? ''}`;
      const version = (documentChangeVersions.get(documentName) ?? 0) + 1;
      documentChangeVersions.set(documentName, version);
      const writers = pendingWriters.get(documentName) ?? new Map<string, PendingWriter>();
      writers.set(writerKey, {
        context: writer,
        version,
        ...(writeAdmission ? { admittedAccessRevision: writeAdmission.accessRevision } : {}),
      });
      pendingWriters.set(documentName, writers);
    },
    onStoreDocument: async (data) => {
      const documentName = data.documentName;

      if (blockedDocuments.has(documentName)) return;
      if (isMetaRoom(documentName)) {
        logger.debug(`[meta] skip persist for meta room: ${documentName}`);
        return;
      }

      const context = data.context as PersistContext | undefined;
      if (!context?.user) {
        throw new Error('Unauthorized');
      }
      if (!ensureTitleWithinLimit(documentName, data.document)) return;

      const fallbackContext =
        server.hocuspocus.documents.get(documentName) === data.document ? undefined : context;
      // Capture the resolver audience and the exact connection-index snapshot
      // in one synchronous turn. Updates admitted while persistence waits are
      // left in pendingWriters and indexed by the following save.
      const persistedWriterVersion = documentChangeVersions.get(documentName) ?? 0;
      const connectionResolutionPrincipals = getConnectionResolutionPrincipals(
        documentName,
        fallbackContext,
        persistedWriterVersion,
      );
      const state = Y.encodeStateAsUpdate(data.document);
      if (
        !(await canPersistPendingDocument(
          documentName,
          fallbackContext,
          undefined,
          persistedWriterVersion,
        ))
      )
        return;

      if (!state || state.length === 0) {
        logger.debug(`[persist] skipping empty state: ${documentName}`);
        return;
      }
      if (state.length > maxDocumentBytes) {
        blockOversizedDocument(documentName, state.length);
        return;
      }

      logger.info(`[persist] saving: "${documentName}", size: ${state.length} bytes`);
      try {
        const persisted = await persistDocument(
          pool,
          server.hocuspocus,
          documentName,
          data.document,
          state,
          connectionResolutionPrincipals,
          canonicalPageTitles.get(documentName),
          maxDocumentBytes,
          logger,
          (client) =>
            canPersistPendingDocument(
              documentName,
              fallbackContext,
              client,
              persistedWriterVersion,
            ),
        );
        if (!persisted.committed) return;
        clearPersistedWriters(documentName, persistedWriterVersion);
        canonicalPageTitles.set(documentName, persisted.canonicalTitle);
        acceptedPageTitles.set(documentName, persisted.canonicalTitle);
        pendingTitleBaselines.delete(documentName);
        documentSizeEstimates.set(documentName, persisted.stateSize);
        logger.debug(`[persist] saved: ${documentName}`);
      } catch (err) {
        if (err instanceof Error && err.message === 'Document size limit exceeded') {
          blockOversizedDocument(documentName, Y.encodeStateAsUpdate(data.document).length);
          return;
        }
        logger.error(`[persist] failed to save "${documentName}": ${err}`);
        throw err;
      }
    },
    afterUnloadDocument: async ({ documentName }) => {
      blockedDocuments.delete(documentName);
      pendingWriters.delete(documentName);
      documentChangeVersions.delete(documentName);
      documentSizeEstimates.delete(documentName);
      acceptedPageTitles.delete(documentName);
      canonicalPageTitles.delete(documentName);
      pendingTitleBaselines.delete(documentName);
    },
    onDisconnect: async ({ documentName, instance, context }) => {
      if (isMetaRoom(documentName) || blockedDocuments.has(documentName)) return;

      // A socket can close while its final update is still waiting on the
      // authorization fence. Let that accepted message reach onChange before
      // deciding whether this disconnect has a writer to flush.
      const disconnectContext = context as PersistContext | undefined;
      await disconnectContext?.permissionCheck?.catch(() => undefined);
      await disconnectContext?.applicationCheck?.catch(() => undefined);
      await Promise.resolve();

      const doc = instance.documents.get(documentName) as Y.Doc | undefined;
      if (!doc) return;

      try {
        if (!ensureTitleWithinLimit(documentName, doc)) return;
        const persistedWriterVersion = documentChangeVersions.get(documentName) ?? 0;
        const connectionResolutionPrincipals = getConnectionResolutionPrincipals(
          documentName,
          undefined,
          persistedWriterVersion,
        );
        const state = Y.encodeStateAsUpdate(doc);
        if (
          !(await canPersistPendingDocument(
            documentName,
            undefined,
            undefined,
            persistedWriterVersion,
          ))
        )
          return;

        if (!state || state.length === 0) return;
        if (state.length > maxDocumentBytes) {
          blockOversizedDocument(documentName, state.length);
          return;
        }

        logger.info(`[disconnect] force saving: ${documentName}, ${state.length} bytes`);
        const persisted = await persistDocument(
          pool,
          server.hocuspocus,
          documentName,
          doc,
          state,
          connectionResolutionPrincipals,
          canonicalPageTitles.get(documentName),
          maxDocumentBytes,
          logger,
          (client) =>
            canPersistPendingDocument(documentName, undefined, client, persistedWriterVersion),
        );
        if (!persisted.committed) return;
        clearPersistedWriters(documentName, persistedWriterVersion);
        canonicalPageTitles.set(documentName, persisted.canonicalTitle);
        acceptedPageTitles.set(documentName, persisted.canonicalTitle);
        pendingTitleBaselines.delete(documentName);
        documentSizeEstimates.set(documentName, persisted.stateSize);
        logger.debug(`[disconnect] force saved: ${documentName}`);
      } catch (err) {
        logger.error(`[disconnect] force save failed for "${documentName}": ${err}`);
      }
    },
    extensions: [],
  });
  canonicalTitlesByServer.set(server.hocuspocus, canonicalPageTitles);
  acceptedTitlesByServer.set(server.hocuspocus, acceptedPageTitles);
  pendingTitleBaselinesByServer.set(server.hocuspocus, pendingTitleBaselines);
  server.webSocketServer.options.maxPayload = maxPayloadBytes;

  const shareEventQueue = createCoalescingTaskQueue<ShareEventPayload>({
    maxPending: SHARE_EVENT_QUEUE_LIMIT,
    getKey: getShareEventQueueKey,
    mergePending: mergeShareEventMetadata,
    handle: (payload) => handleShareEvent(server, payload, pool, logger),
    handleOverflow: async () => {
      logger.warn(
        `[listen] share event backlog exceeded ${SHARE_EVENT_QUEUE_LIMIT}; rebuilding active collaboration state`,
      );
      await Promise.all([
        rebuildActivePageMetaDocuments(server.hocuspocus, pool, logger, {
          reconcileTitles: false,
        }),
        revalidateActivePageConnections(server, pool, logger),
      ]);
    },
    onError: (error) => logger.error(`[listen] handleShareEvent failed: ${error}`),
  });

  const grantEventQueue = createCoalescingTaskQueue<GrantReceivedPayload>({
    maxPending: GRANT_EVENT_QUEUE_LIMIT,
    getKey: (payload) => `${payload.targetUserId}:${payload.entityType}:${payload.entityId}`,
    handle: handleGrantReceived,
    handleOverflow: async () => {
      logger.warn(
        `[listen] grant event backlog exceeded ${GRANT_EVENT_QUEUE_LIMIT}; rebuilding active metadata rooms`,
      );
      await rebuildActivePageMetaDocuments(server.hocuspocus, pool, logger, {
        reconcileTitles: false,
      });
    },
    onError: (error) => logger.error(`[listen] handleGrantReceived failed: ${error}`),
  });

  const workspaceEventQueue = createCoalescingTaskQueue<WorkspaceEventPayload>({
    maxPending: WORKSPACE_EVENT_QUEUE_LIMIT,
    getKey: (payload) => `${payload.ownerId}:${payload.memberId}`,
    handle: (payload) => handleWorkspaceEvent(server, payload, pool, logger),
    handleOverflow: async () => {
      logger.warn(
        `[listen] workspace event backlog exceeded ${WORKSPACE_EVENT_QUEUE_LIMIT}; rebuilding active collaboration state`,
      );
      const invalidationMessage = JSON.stringify({
        type: 'workspace_membership_event',
        action: 'role_changed',
        ownerId: 'all',
      });
      for (const document of getActiveMetaDocuments(server.hocuspocus).values()) {
        for (const connection of document.getConnections()) {
          connection.sendStateless(invalidationMessage);
        }
      }
      await Promise.all([
        rebuildActivePageMetaDocuments(server.hocuspocus, pool, logger, {
          reconcileTitles: false,
        }),
        revalidateActivePageConnections(server, pool, logger),
      ]);
    },
    onError: (error) => logger.error(`[listen] handleWorkspaceEvent failed: ${error}`),
  });

  let permissionRevalidationTask: Promise<unknown> | null = null;
  const permissionRevalidationTimer =
    permissionRevalidationMs > 0
      ? setInterval(() => {
          if (permissionRevalidationTask) return;
          permissionRevalidationTask = Promise.all([
            revalidateActivePageConnections(server, pool, logger),
            rebuildActivePageMetaDocuments(server.hocuspocus, pool, logger, {
              invalidateBacklinks: false,
              bumpAccessVersion: true,
              reconcileTitles: false,
            }),
          ])
            .catch((error) => {
              logger.error(
                `[reconcile] active access and metadata reconciliation failed: ${error}`,
              );
            })
            .finally(() => {
              permissionRevalidationTask = null;
            });
        }, permissionRevalidationMs)
      : null;
  permissionRevalidationTimer?.unref();

  const destroyBeforePermissionTimer = server.destroy.bind(server);
  Object.defineProperty(server, 'destroy', {
    async value() {
      if (permissionRevalidationTimer) clearInterval(permissionRevalidationTimer);
      shareEventQueue.drainAndStop();
      grantEventQueue.drainAndStop();
      workspaceEventQueue.drainAndStop();
      await Promise.allSettled(
        Array.from(activeApplicationFences, (fence) => fence.complete(false, false)),
      );
      await Promise.all([
        shareEventQueue.waitForIdle(),
        grantEventQueue.waitForIdle(),
        workspaceEventQueue.waitForIdle(),
        permissionRevalidationTask ?? Promise.resolve(),
      ]);
      return destroyBeforePermissionTimer();
    },
    writable: true,
    configurable: true,
  });

  const listenUrl = config.databaseUrl;
  if (listenUrl) {
    let listenClient: Client | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;
    let stopped = false;
    const MAX_RECONNECT_DELAY = 30000;

    async function handlePageRenamed(pageId: string): Promise<void> {
      const renameClient = await pool.connect();
      try {
        await renameClient.query('begin');
        await lockDocumentAccessMutation(pageId, renameClient);
        const titleRevision = await lockActivePage(pageId, renameClient);
        const result = await renameClient.query<{ title: string }>(
          'select title from pages where id = $1 and is_deleted = false',
          [pageId],
        );
        const title = result.rows[0]?.title;
        if (title === undefined) {
          await renameClient.query('rollback');
          logger.debug(`[listen] renamed page ${pageId} is no longer active, skipping`);
          return;
        }
        const activeDocument = server.hocuspocus.documents.get(pageId) as Document | undefined;
        const previousCanonicalTitle = canonicalPageTitles.get(pageId);
        const preserveLaterCollaborativeTitle =
          activeDocument !== undefined &&
          previousCanonicalTitle !== undefined &&
          activeDocument.getText('title').toString() !== previousCanonicalTitle &&
          pendingTitleBaselines.get(pageId) === titleRevision;
        await publishPageRename(server.hocuspocus, pool, pageId, title, logger, {
          applyToActive: !preserveLaterCollaborativeTitle,
        });
        canonicalPageTitles.set(pageId, title);
        if (!preserveLaterCollaborativeTitle) {
          acceptedPageTitles.set(pageId, title);
          pendingTitleBaselines.delete(pageId);
        }
        await renameClient.query('commit');
      } catch (error) {
        await renameClient.query('rollback').catch(() => undefined);
        if (error instanceof CollabAccessError) {
          logger.debug(`[listen] renamed page ${pageId} is no longer active, skipping`);
          return;
        }
        throw error;
      } finally {
        renameClient.release();
      }
    }

    async function handlePageDeleted(pageId: string): Promise<void> {
      await publishPageDeletion(server.hocuspocus, pool, pageId, logger);
    }

    async function handleFolderDeleted(folderId: string): Promise<void> {
      await publishFolderDeletion(server.hocuspocus, pool, folderId, logger);
    }

    type DeletionEvent = { entityType: 'page' | 'folder'; entityId: string };
    const deletionEventQueue = createCoalescingTaskQueue<DeletionEvent>({
      maxPending: DELETION_EVENT_QUEUE_LIMIT,
      getKey: (event) => `${event.entityType}:${event.entityId}`,
      handle: (event) =>
        event.entityType === 'page'
          ? handlePageDeleted(event.entityId)
          : handleFolderDeleted(event.entityId),
      handleOverflow: async () => {
        logger.warn(
          `[listen] deletion event backlog exceeded ${DELETION_EVENT_QUEUE_LIMIT}; rebuilding active state`,
        );
        await reconcileDeletionOverflow(server.hocuspocus, pool, logger);
      },
      onError: (error) => logger.error(`[listen] deletion event failed: ${error}`),
    });

    const pageRenameEventQueue = createCoalescingTaskQueue<string>({
      maxPending: PAGE_RENAME_EVENT_QUEUE_LIMIT,
      getKey: (pageId) => pageId,
      handle: handlePageRenamed,
      handleOverflow: async () => {
        logger.warn(
          `[listen] page rename backlog exceeded ${PAGE_RENAME_EVENT_QUEUE_LIMIT}; rebuilding active metadata rooms`,
        );
        await rebuildActivePageMetaDocuments(server.hocuspocus, pool, logger);
      },
      onError: (error) => logger.error(`[listen] handlePageRenamed failed: ${error}`),
    });

    function scheduleReconnect() {
      if (stopped) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const delay = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY);
      reconnectAttempts += 1;
      reconnectTimer = setTimeout(connectListenClient, delay);
    }

    async function connectListenClient(): Promise<void> {
      if (stopped) return;

      // Clean up existing client if any
      if (listenClient) {
        const staleClient = listenClient;
        listenClient = null;
        try {
          staleClient.removeAllListeners('notification');
          staleClient.removeAllListeners('error');
          staleClient.removeAllListeners('end');
          await staleClient.end();
        } catch (error) {
          logger.error(`[listen] failed to close stale client: ${error}`);
        }
      }

      let client: Client | null = null;
      try {
        client = new Client({ connectionString: listenUrl });
        await client.connect();

        client.on('notification', (msg) => {
          try {
            if (msg.channel === 'page_deleted') {
              const payload = JSON.parse(msg.payload ?? '{}') as { pageId?: string };
              if (!payload.pageId) return;
              deletionEventQueue.enqueue({ entityType: 'page', entityId: payload.pageId });
            } else if (msg.channel === 'folder_deleted') {
              const payload = JSON.parse(msg.payload ?? '{}') as { folderId?: string };
              if (!payload.folderId) return;
              deletionEventQueue.enqueue({ entityType: 'folder', entityId: payload.folderId });
            } else if (msg.channel === 'page_renamed') {
              const payload = JSON.parse(msg.payload ?? '{}') as { pageId?: string };
              if (!payload.pageId) return;
              pageRenameEventQueue.enqueue(payload.pageId);
            } else if (msg.channel === 'share_event') {
              logger.debug(`[listen] received share_event: ${msg.payload}`);
              const payload: ShareEventPayload | GrantReceivedPayload = JSON.parse(
                msg.payload ?? '{}',
              );
              if (!payload.entityId) {
                logger.debug('[listen] share_event missing entityId, skipping');
                return;
              }
              if (payload.type === 'grant_received') {
                grantEventQueue.enqueue(payload);
              } else {
                shareEventQueue.enqueue(payload);
              }
            } else if (msg.channel === 'workspace_event') {
              logger.debug(`[listen] received workspace_event: ${msg.payload}`);
              const payload = JSON.parse(msg.payload ?? '{}') as Partial<WorkspaceEventPayload>;
              if (
                !payload.ownerId ||
                !payload.memberId ||
                (payload.action !== 'member_added' &&
                  payload.action !== 'member_removed' &&
                  payload.action !== 'role_changed')
              ) {
                logger.debug('[listen] malformed workspace_event, skipping');
                return;
              }
              workspaceEventQueue.enqueue({
                type: 'workspace_event',
                action: payload.action,
                ownerId: payload.ownerId,
                memberId: payload.memberId,
                ...(typeof payload.message === 'string' ? { message: payload.message } : {}),
              });
            }
          } catch (err) {
            logger.error(`[listen] failed to process notification: ${err}`);
          }
        });

        client.on('error', (err) => {
          logger.error(`[listen] client error: ${err.message}`);
          scheduleReconnect();
        });

        client.on('end', () => {
          logger.warn('[listen] client connection ended');
          scheduleReconnect();
        });

        // Install handlers before the first LISTEN so notifications delivered
        // while the remaining channels subscribe or recovery runs are queued.
        await client.query('LISTEN page_renamed');
        await client.query('LISTEN page_deleted');
        await client.query('LISTEN folder_deleted');
        await client.query('LISTEN share_event');
        await client.query('LISTEN workspace_event');

        listenClient = client;
        await reconcileActiveCollaborationState(server, pool, logger);
        reconnectAttempts = 0;
        logger.info(
          '[listen] subscribed and reconciled page_renamed, page_deleted, folder_deleted, share_event, and workspace_event',
        );
      } catch (err) {
        logger.error(`[listen] connection failed: ${err}`);
        if (listenClient === client) listenClient = null;
        if (client) {
          client.removeAllListeners('notification');
          client.removeAllListeners('error');
          client.removeAllListeners('end');
          await client.end().catch((error: unknown) => {
            logger.error(`[listen] failed to close unsuccessful client: ${error}`);
          });
        }
        scheduleReconnect();
      }
    }

    connectListenClient();

    // Clean up the listen client and reconnect timers when the server is
    // destroyed (e.g. graceful shutdown or test teardown). Without this,
    // the dangling pg.Client and its timers would leak and keep retrying.
    const origDestroy = server.destroy.bind(server);
    Object.defineProperty(server, 'destroy', {
      async value() {
        stopped = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        deletionEventQueue.drainAndStop();
        pageRenameEventQueue.drainAndStop();
        const activeListenClient = listenClient;
        listenClient = null;
        const closeListenClient = activeListenClient
          ? activeListenClient.end().catch((error: unknown) => {
              logger.error(`[listen] failed to close client during shutdown: ${error}`);
            })
          : Promise.resolve();
        await Promise.all([
          closeListenClient,
          deletionEventQueue.waitForIdle(),
          pageRenameEventQueue.waitForIdle(),
        ]);
        return origDestroy();
      },
      writable: true,
      configurable: true,
    });
  } else {
    logger.warn('[listen] DATABASE_URL not configured — pg_notify subscriptions disabled');
  }

  return server;
}
