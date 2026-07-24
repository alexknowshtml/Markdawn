type CollaborationLocation = Pick<Location, 'host' | 'protocol'>;

export function getCollaborationUrl(location: CollaborationLocation = window.location): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/collab`;
}
