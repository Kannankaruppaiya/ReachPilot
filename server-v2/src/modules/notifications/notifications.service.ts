import { Injectable } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { getDb } from '@/db';

export interface SseEvent {
  workspaceId: string;
  type: string;
  data: any;
}

@Injectable()
export class NotificationsService {
  private readonly eventBus$ = new Subject<SseEvent>();

  /**
   * Subscribes to SSE stream for a specific workspace.
   */
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

  /**
   * Emit a real-time event to the event stream, optionally storing it in notifications table.
   */
  async emitEvent(
    workspaceId: string,
    type: string,
    data: any,
    storeInDb = false,
    text?: string,
  ): Promise<void> {
    const db = getDb();

    if (storeInDb && text) {
      await db
        .insertInto('notifications')
        .values({
          workspace_id: workspaceId,
          kind: type,
          text,
          refs: JSON.stringify(data),
        })
        .execute();
    }

    // Push to active SSE clients
    this.eventBus$.next({
      workspaceId,
      type,
      data,
    });
  }

  async list(workspaceId: string): Promise<any[]> {
    const db = getDb();
    return db
      .selectFrom('notifications')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .orderBy('created_at', 'desc')
      .execute();
  }

  async markAsRead(workspaceId: string, notificationId: string): Promise<void> {
    const db = getDb();
    await db
      .updateTable('notifications')
      .set({ read_at: new Date().toISOString() })
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', notificationId)
      .execute();
  }
}
