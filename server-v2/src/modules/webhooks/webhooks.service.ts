import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { withWorkspace } from '@/db/rls';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { getEnv } from '@/config/env';

let redisClient: Redis | null = null;
let webhookQueue: Queue | null = null;

function getWebhookQueue(): Queue {
  if (webhookQueue) return webhookQueue;
  const env = getEnv();
  if (!redisClient) redisClient = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  webhookQueue = new Queue('webhook-deliveries', { connection: redisClient as any });
  return webhookQueue;
}

@Injectable()
export class WebhooksService {
  // webhook_endpoints is RLS-scoped; webhook_deliveries isn't but shares the transaction.
  async list(workspaceId: string): Promise<any[]> {
    return withWorkspace(workspaceId, (db) =>
      db
        .selectFrom('webhook_endpoints')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .execute(),
    );
  }

  async create(workspaceId: string, url: string, events: string[]): Promise<any> {
    if (!url || !url.startsWith('http')) {
      throw new BadRequestException('Valid absolute HTTP/HTTPS URL required.');
    }

    const secret = 'whsec_' + crypto.randomBytes(24).toString('hex');

    return withWorkspace(workspaceId, (db) =>
      db
        .insertInto('webhook_endpoints')
        .values({
          workspace_id: workspaceId,
          url,
          secret,
          events,
          active: true,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    await withWorkspace(workspaceId, async (db) => {
      const existing = await db
        .selectFrom('webhook_endpoints')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();

      if (!existing) {
        throw new NotFoundException('Webhook endpoint not found.');
      }

      await db
        .deleteFrom('webhook_endpoints')
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', id)
        .execute();
    });
  }

  /** Queue an event for every subscribed endpoint (HMAC-signed POST via BullMQ). */
  async triggerEvent(workspaceId: string, eventType: string, payload: any): Promise<void> {
    // Enqueue deliveries only after the transaction commits.
    const toSend = await withWorkspace(workspaceId, async (db) => {
      const endpoints = await db
        .selectFrom('webhook_endpoints')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .where('active', '=', true)
        .execute();

      const out: { deliveryId: string; url: string; secret: string }[] = [];
      for (const ep of endpoints) {
        const match = ep.events.includes(eventType) || ep.events.includes('*');
        if (!match) continue;

        const delivery = await db
          .insertInto('webhook_deliveries')
          .values({
            endpoint_id: ep.id,
            event_type: eventType,
            payload: JSON.stringify(payload),
            status: 'pending',
            attempts: 0,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        out.push({ deliveryId: delivery.id, url: ep.url, secret: ep.secret });
      }
      return out;
    });

    const q = getWebhookQueue();
    for (const d of toSend) {
      await q.add(
        'webhook-send',
        {
          deliveryId: d.deliveryId,
          url: d.url,
          secret: d.secret,
          payload,
        },
        {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 10000,
          },
        },
      );
    }
  }
}
