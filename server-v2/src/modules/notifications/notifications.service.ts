import { Injectable } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { withWorkspace } from '@/db/rls';

export interface SseEvent {
  workspaceId: string;
  type: string;
  data: any;
}

@Injectable()
export class NotificationsService {
  private readonly eventBus$ = new Subject<SseEvent>();

  /** SSE stream for one workspace. */
  getEventStream(workspaceId: string): Observable<{ data: string }> {
    return this.eventBus$.asObservable().pipe(
      filter((event) => event.workspaceId === workspaceId),
      map((event) => ({
        data: JSON.stringify({
          type: event.type,
          data: event.data,
        }),
      })),
    );
  }

  /** Emit a real-time event, optionally also storing it as a notification. */
  async emitEvent(
    workspaceId: string,
    type: string,
    data: any,
    storeInDb = false,
    text?: string,
  ): Promise<void> {
    if (storeInDb && text) {
      await withWorkspace(workspaceId, (db) =>
        db
          .insertInto('notifications')
          .values({
            workspace_id: workspaceId,
            kind: type,
            text,
            refs: JSON.stringify(data),
          })
          .execute(),
      );
    }

    this.eventBus$.next({
      workspaceId,
      type,
      data,
    });
  }

  async list(workspaceId: string): Promise<any[]> {
    return withWorkspace(workspaceId, (db) =>
      db
        .selectFrom('notifications')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .orderBy('created_at', 'desc')
        .execute(),
    );
  }

  async markAsRead(workspaceId: string, notificationId: string): Promise<void> {
    await withWorkspace(workspaceId, (db) =>
      db
        .updateTable('notifications')
        .set({ read_at: new Date().toISOString() })
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', notificationId)
        .execute(),
    );
  }
}
