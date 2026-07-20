/** Format the verified account-grant data for a recipient-facing toast. */
export function formatGrantNotification(sharedByName: string, entityTitle: string): string {
  return `${sharedByName} shared ${entityTitle} with you`;
}
