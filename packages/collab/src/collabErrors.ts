import { COLLAB_TERMINAL_REASONS } from '@markdawn/shared';

export class CollabAccessError extends Error {
  readonly code = 'COLLAB_ACCESS_DENIED';
  readonly accessRevision: string | undefined;

  constructor(accessRevision?: string) {
    super('Forbidden');
    this.name = 'CollabAccessError';
    this.accessRevision = accessRevision;
  }
}

export class CollabVerificationError extends Error {
  readonly code = 'COLLAB_VERIFICATION_FAILED';
  readonly originalError: unknown;

  constructor(originalError: unknown) {
    super(COLLAB_TERMINAL_REASONS.PERMISSION_VERIFICATION_FAILED);
    this.name = 'CollabVerificationError';
    this.originalError = originalError;
  }
}

export class CollabWriteDeniedError extends Error {
  readonly code = 4403;

  constructor() {
    super('Write permission required');
    this.name = 'CollabWriteDeniedError';
  }
}

export class CollabProtocolDeniedError extends Error {
  readonly code = 4403;

  constructor(message = 'Client stateless messages are not allowed') {
    super(message);
    this.name = 'CollabProtocolDeniedError';
  }
}
