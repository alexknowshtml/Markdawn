import { Connection } from '@hocuspocus/server';
import type { PoolClient } from 'pg';
import { CollabProtocolDeniedError } from './collabErrors';
import {
  type ApplicationFence,
  applicationFencesByMessage,
  expiredApplicationMessages,
  getConnectionLifecycle,
  removePendingWriteAdmission,
  type WriteAdmission,
  type WriteAdmissionContext,
} from './hocuspocusV3Adapter';
import type { PageTitleRuntime } from './pageTitleRuntime';
import { createWriteApplicationRuntime } from './writeApplicationRuntime';

type WriteAdmissionRuntimeOptions = {
  timeoutMs: number;
  titles: PageTitleRuntime;
  blockDocument(documentName: string, code: number, reason: string): void;
};

export function createWriteAdmissionRuntime({
  timeoutMs,
  titles,
  blockDocument,
}: WriteAdmissionRuntimeOptions) {
  const activeFences = new Set<ApplicationFence>();
  const applications = createWriteApplicationRuntime();

  function record(
    context: WriteAdmissionContext,
    accessRevision: string,
    titleRevision: string | undefined,
    touchesTitle: boolean,
    hasWriteUpdate: boolean,
  ): WriteAdmission | undefined {
    if (!hasWriteUpdate || !titleRevision) return undefined;
    const pending = getConnectionLifecycle(context).pendingWriteAdmissions;
    if (pending.length >= 64) {
      throw new CollabProtocolDeniedError('Too many writes awaiting application');
    }
    const admission = { accessRevision, titleRevision, touchesTitle };
    pending.push(admission);
    return admission;
  }

  function retainThroughApplication(options: {
    admission: WriteAdmission;
    connection: unknown;
    context: WriteAdmissionContext;
    documentName: string;
    message: Uint8Array;
    client: PoolClient;
  }): boolean {
    const { admission, connection, context, documentName, message, client } = options;
    if (!(connection instanceof Connection)) return false;
    const previousTitleBaseline = titles.getPendingBaseline(documentName);
    if (admission.touchesTitle) titles.setPendingBaseline(documentName, admission.titleRevision);
    applications.begin(context);
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const fence: ApplicationFence = {
      admission,
      context,
      async complete(applied, changed = applied) {
        if (settled) return;
        settled = true;
        if (!applied) expiredApplicationMessages.add(message);
        if (timeout) clearTimeout(timeout);
        applicationFencesByMessage.delete(message);
        activeFences.delete(fence);
        let committed = false;
        try {
          await client.query(applied ? 'COMMIT' : 'ROLLBACK');
          committed = applied;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          blockDocument(documentName, 4500, 'Write application commit failed');
          throw error;
        } finally {
          if (admission.touchesTitle && (!committed || !changed)) {
            titles.restorePendingBaseline(
              documentName,
              admission.titleRevision,
              previousTitleBaseline,
            );
          }
          client.release();
          applications.finish(context);
        }
      },
    };
    applicationFencesByMessage.set(message, fence);
    activeFences.add(fence);
    timeout = setTimeout(() => {
      removePendingWriteAdmission(context, admission);
      void fence
        .complete(false, false)
        .catch(() => undefined)
        .finally(() => connection.close({ code: 4500, reason: 'Write application timed out' }));
    }, timeoutMs);
    timeout.unref();
    return true;
  }

  return {
    completeAll: () =>
      Promise.allSettled(Array.from(activeFences, (fence) => fence.complete(false, false))),
    record,
    retainThroughApplication,
  };
}
