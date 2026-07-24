import type { onAuthenticationFailedParameters, onCloseParameters } from '@hocuspocus/provider';

type StatelessMessage = { payload: string };

export type CollaborationEventHandlers = {
  onStateless: (message: StatelessMessage) => void;
  onClose: (parameters: onCloseParameters) => void;
  onAuthenticationFailed: (parameters: onAuthenticationFailedParameters) => void;
};

/**
 * Buffers provider constructor callbacks until the lifecycle controller is
 * mounted. One bridge belongs to one provider generation.
 */
export class CollaborationEventBridge {
  private handlers: CollaborationEventHandlers | null = null;
  private pendingStateless: StatelessMessage[] = [];
  private pendingClose: onCloseParameters[] = [];
  private pendingAuthenticationFailures: onAuthenticationFailedParameters[] = [];

  constructor(private readonly isActive: () => boolean) {}

  readonly onStateless = (message: StatelessMessage): void => {
    if (!this.isActive()) return;
    if (this.handlers) this.handlers.onStateless(message);
    else this.pendingStateless.push(message);
  };

  readonly onClose = (parameters: onCloseParameters): void => {
    if (!this.isActive()) return;
    if (this.handlers) this.handlers.onClose(parameters);
    else this.pendingClose.push(parameters);
  };

  readonly onAuthenticationFailed = (parameters: onAuthenticationFailedParameters): void => {
    if (!this.isActive()) return;
    if (this.handlers) this.handlers.onAuthenticationFailed(parameters);
    else this.pendingAuthenticationFailures.push(parameters);
  };

  bind(handlers: CollaborationEventHandlers): () => void {
    this.handlers = handlers;
    for (const message of this.pendingStateless.splice(0)) handlers.onStateless(message);
    for (const parameters of this.pendingClose.splice(0)) handlers.onClose(parameters);
    for (const parameters of this.pendingAuthenticationFailures.splice(0)) {
      handlers.onAuthenticationFailed(parameters);
    }
    return () => {
      if (this.handlers === handlers) this.handlers = null;
    };
  }
}
