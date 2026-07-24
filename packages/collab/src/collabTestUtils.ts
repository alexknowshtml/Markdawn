export function encodeVarUint(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return Uint8Array.from(bytes);
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export function encodeVarString(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  return concatBytes([encodeVarUint(bytes.length), bytes]);
}

export function encodeProtocolMessage(
  documentName: string,
  messageType: number,
  payload?: string,
): Uint8Array {
  return concatBytes([
    encodeVarString(documentName),
    encodeVarUint(messageType),
    ...(payload === undefined ? [] : [encodeVarString(payload)]),
  ]);
}

export function encodeAuthenticationMessage(documentName: string, token: string): Uint8Array {
  return concatBytes([
    encodeVarString(documentName),
    encodeVarUint(2),
    encodeVarUint(0),
    encodeVarString(token),
  ]);
}

export function encodeAwarenessMessage(
  documentName: string,
  entries: Array<{ clientId: number; clock: number; state: unknown }>,
): Uint8Array {
  const awarenessPayload = concatBytes([
    encodeVarUint(entries.length),
    ...entries.flatMap((entry) => [
      encodeVarUint(entry.clientId),
      encodeVarUint(entry.clock),
      encodeVarString(JSON.stringify(entry.state)),
    ]),
  ]);
  return concatBytes([
    encodeVarString(documentName),
    encodeVarUint(1),
    encodeVarUint(awarenessPayload.length),
    awarenessPayload,
  ]);
}
