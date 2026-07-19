export const MAX_WIKI_LINK_PRESENTATION_REQUESTS = 200;

export interface WikiLinkPresentationRequest {
  key: string;
  targetId?: string;
  path?: string;
}

export type WikiLinkPresentation =
  | {
      key: string;
      state: 'accessible';
      target: { id: string; title: string };
    }
  | { key: string; state: 'restricted' }
  | { key: string; state: 'unavailable' };

export interface WikiLinkPresentationResponse {
  links: WikiLinkPresentation[];
}
