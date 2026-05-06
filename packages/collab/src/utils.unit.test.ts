import { describe, expect, it } from 'vitest';
import { getDbHostname, parseCookies } from './utils';

describe('getDbHostname', () => {
  it('extracts hostname from a standard postgres URL', () => {
    expect(getDbHostname('postgresql://user:pass@localhost:5432/db')).toBe('localhost');
  });

  it('extracts hostname from a URL without port', () => {
    expect(getDbHostname('postgresql://user:pass@mydb.example.com/db')).toBe('mydb.example.com');
  });

  it('returns empty string for an invalid URL', () => {
    expect(getDbHostname('not-a-url')).toBe('');
  });

  it('identifies localhost', () => {
    expect(getDbHostname('postgresql://localhost/db')).toBe('localhost');
  });

  it('identifies 127.0.0.1', () => {
    expect(getDbHostname('postgresql://127.0.0.1:5432/db')).toBe('127.0.0.1');
  });
});

describe('parseCookies', () => {
  it('returns empty map for undefined header', () => {
    const cookies = parseCookies(undefined);
    expect(cookies.size).toBe(0);
  });

  it('returns empty map for empty string', () => {
    const cookies = parseCookies('');
    expect(cookies.size).toBe(0);
  });

  it('parses a single cookie', () => {
    const cookies = parseCookies('session=abc123');
    expect(cookies.get('session')).toBe('abc123');
  });

  it('parses multiple cookies', () => {
    const cookies = parseCookies('a=1; b=2; c=3');
    expect(cookies.get('a')).toBe('1');
    expect(cookies.get('b')).toBe('2');
    expect(cookies.get('c')).toBe('3');
  });

  it('URL-decodes cookie values', () => {
    const cookies = parseCookies('data=hello%20world');
    expect(cookies.get('data')).toBe('hello world');
  });

  it('skips entries with empty keys', () => {
    const cookies = parseCookies('=value; valid=yes');
    expect(cookies.get('valid')).toBe('yes');
    expect(cookies.has('')).toBe(false);
  });

  it('handles the __Secure- cookie prefix', () => {
    const cookies = parseCookies('__Secure-better-auth.session_token=secure-token');
    expect(cookies.get('__Secure-better-auth.session_token')).toBe('secure-token');
  });

  it('handles equals signs inside a value', () => {
    const cookies = parseCookies('data=a=b=c');
    expect(cookies.get('data')).toBe('a=b=c');
  });

  it('handles trailing whitespace', () => {
    const cookies = parseCookies('  key=value  ;  another=val');
    expect(cookies.get('key')).toBe('value');
    expect(cookies.get('another')).toBe('val');
  });
});
