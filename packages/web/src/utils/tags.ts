export function cleanTagName(value: string): string {
  return value.trim().replace(/^#+/, '').trim();
}

export function tagIdentity(value: string): string {
  return cleanTagName(value).toLowerCase();
}
