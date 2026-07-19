import {
  MAX_WIKI_LINK_PRESENTATION_REQUESTS,
  normalizeWikiLinkLookupKey,
  type WikiLinkPresentation,
  type WikiLinkPresentationResponse,
} from '@markdawn/shared';
import type { EditorView } from '@milkdown/kit/prose/view';

export type WikiLinkReference = { targetId?: string; path?: string };
export type WikiLinkNavigationTarget = { id: string; title: string; heading?: string };
export type ResolvedWikiLinkPresentation =
  | { state: 'loading' }
  | { state: 'accessible'; target: { id: string; title: string } }
  | { state: 'restricted' }
  | { state: 'unavailable' };

type PresentationResolver = (
  requests: Array<WikiLinkReference & { key: string }>,
) => Promise<WikiLinkPresentation[]>;
type PresentationListener = (presentation: ResolvedWikiLinkPresentation) => void;

type PresentationEntry = {
  requestKey: string;
  reference: WikiLinkReference;
  listeners: Set<PresentationListener>;
  presentation: ResolvedWikiLinkPresentation;
  needsResolution: boolean;
  resolving: boolean;
  version: number;
};

type PresentationCoordinator = {
  entries: Map<string, PresentationEntry>;
  resolver: PresentationResolver | null;
  scheduled: boolean;
  generation: number;
  nextRequestKey: number;
};

const coordinators = new WeakMap<EditorView, PresentationCoordinator>();

function getCoordinator(view: EditorView): PresentationCoordinator {
  const existing = coordinators.get(view);
  if (existing) return existing;
  const coordinator: PresentationCoordinator = {
    entries: new Map(),
    resolver: null,
    scheduled: false,
    generation: 0,
    nextRequestKey: 0,
  };
  coordinators.set(view, coordinator);
  return coordinator;
}

function referenceKey(reference: WikiLinkReference): string {
  if (reference.targetId) return `id:${reference.targetId.toLowerCase()}`;
  return `path:${normalizeWikiLinkLookupKey(reference.path ?? '')}`;
}

function notify(entry: PresentationEntry): void {
  for (const listener of entry.listeners) listener(entry.presentation);
}

async function resolveEntries(
  coordinator: PresentationCoordinator,
  entries: PresentationEntry[],
): Promise<void> {
  const resolver = coordinator.resolver;
  if (!resolver || entries.length === 0) return;
  const generation = coordinator.generation;
  const versions = new Map(entries.map((entry) => [entry, entry.version]));
  for (const entry of entries) {
    entry.needsResolution = false;
    entry.resolving = true;
  }

  try {
    const presentations = await resolver(
      entries.map((entry) => ({ key: entry.requestKey, ...entry.reference })),
    );
    if (generation !== coordinator.generation || coordinator.resolver !== resolver) return;
    const byKey = new Map(presentations.map((presentation) => [presentation.key, presentation]));
    for (const entry of entries) {
      if (entry.version !== versions.get(entry)) continue;
      const presentation = byKey.get(entry.requestKey);
      entry.presentation = presentation
        ? presentation.state === 'accessible'
          ? { state: 'accessible', target: presentation.target }
          : { state: presentation.state }
        : { state: 'unavailable' };
      notify(entry);
    }
  } catch {
    if (generation !== coordinator.generation || coordinator.resolver !== resolver) return;
    for (const entry of entries) {
      if (entry.version !== versions.get(entry)) continue;
      entry.presentation = { state: 'unavailable' };
      notify(entry);
    }
  } finally {
    for (const entry of entries) entry.resolving = false;
    scheduleResolution(coordinator);
  }
}

function scheduleResolution(coordinator: PresentationCoordinator): void {
  if (coordinator.scheduled || !coordinator.resolver) return;
  coordinator.scheduled = true;
  queueMicrotask(() => {
    coordinator.scheduled = false;
    const entries = [...coordinator.entries.values()].filter(
      (entry) => entry.listeners.size > 0 && entry.needsResolution && !entry.resolving,
    );
    for (let offset = 0; offset < entries.length; offset += MAX_WIKI_LINK_PRESENTATION_REQUESTS) {
      void resolveEntries(
        coordinator,
        entries.slice(offset, offset + MAX_WIKI_LINK_PRESENTATION_REQUESTS),
      );
    }
  });
}

export function registerWikiLinkPresentationResolver(
  view: EditorView,
  resolver: PresentationResolver,
): () => void {
  const coordinator = getCoordinator(view);
  coordinator.resolver = resolver;
  coordinator.generation += 1;
  for (const entry of coordinator.entries.values()) {
    entry.needsResolution = true;
  }
  scheduleResolution(coordinator);

  return () => {
    if (coordinator.resolver !== resolver) return;
    coordinator.resolver = null;
    coordinator.generation += 1;
  };
}

export function subscribeToWikiLinkPresentation(
  view: EditorView,
  reference: WikiLinkReference,
  listener: PresentationListener,
): () => void {
  const coordinator = getCoordinator(view);
  const key = referenceKey(reference);
  let entry = coordinator.entries.get(key);
  if (!entry) {
    entry = {
      requestKey: (coordinator.nextRequestKey++).toString(36),
      reference,
      listeners: new Set(),
      presentation: { state: 'loading' },
      needsResolution: true,
      resolving: false,
      version: 0,
    };
    coordinator.entries.set(key, entry);
  }
  entry.listeners.add(listener);
  listener(entry.presentation);
  scheduleResolution(coordinator);

  return () => {
    entry?.listeners.delete(listener);
  };
}

export function refreshWikiLinkPresentations(
  view: EditorView,
  targetIds?: readonly string[],
): void {
  const coordinator = getCoordinator(view);
  const targetIdSet = targetIds
    ? new Set(targetIds.map((targetId) => targetId.toLowerCase()))
    : null;
  for (const entry of coordinator.entries.values()) {
    const resolvedTargetId =
      entry.presentation.state === 'accessible' ? entry.presentation.target.id.toLowerCase() : null;
    if (
      targetIdSet &&
      !(
        (entry.reference.targetId && targetIdSet.has(entry.reference.targetId.toLowerCase())) ||
        (resolvedTargetId && targetIdSet.has(resolvedTargetId))
      )
    ) {
      continue;
    }
    entry.version += 1;
    entry.presentation = { state: 'loading' };
    entry.needsResolution = true;
    notify(entry);
  }
  scheduleResolution(coordinator);
}

export async function fetchWikiLinkPresentations(
  sourcePageId: string,
  requests: Array<WikiLinkReference & { key: string }>,
): Promise<WikiLinkPresentation[]> {
  const response = await fetch(`/api/pages/${sourcePageId}/wiki-link-presentations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ links: requests }),
  });
  if (!response.ok) throw new Error('Failed to resolve wiki links');
  const body = (await response.json()) as WikiLinkPresentationResponse;
  if (!body || !Array.isArray(body.links)) throw new Error('Malformed wiki-link response');
  for (const link of body.links) {
    if (!link || typeof link.key !== 'string') throw new Error('Malformed wiki-link response');
    if (link.state === 'accessible') {
      if (
        !link.target ||
        typeof link.target.id !== 'string' ||
        typeof link.target.title !== 'string'
      ) {
        throw new Error('Malformed wiki-link response');
      }
      continue;
    }
    if (link.state !== 'restricted' && link.state !== 'unavailable') {
      throw new Error('Malformed wiki-link response');
    }
  }
  return body.links;
}
