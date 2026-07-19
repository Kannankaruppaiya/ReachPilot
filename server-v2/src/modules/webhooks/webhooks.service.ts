import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { getDb } from '@/db';
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
  async list(workspaceId: string): Promise<any[]> {
    const db = getDb();
    return db
      .selectFrom('webhook_endpoints')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .execute();
  }

  async create(workspaceId: string, url: string, events: string[]): Promise<any> {
    if (!url || !url.startsWith('http')) {
      throw new BadRequestException('Valid absolute HTTP/HTTPS URL required.');
    }

    const secret = 'whsec_' + crypto.randomBytes(24).toString('hex');
    const db = getDb();

    return db
      .insertInto('webhook_endpoints')
      .values({
        workspace_id: workspaceId,
        url,
        secret,
        events,
        active: true,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    const db = getDb();
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
      .where('id', '=', id)
      .execute();
  }

  /**
   * Triggers a webhook event. Finds all matching endpoints, creates delivery rows
   * in database, and schedules them in BullMQ for asynchronous HMAC-signed post.
   */
  async triggerEvent(workspaceId: string, eventType: string, payload: any): Promise<void> {
    const db = getDb();
    const endpoints = await db
      .selectFrom('webhook_endpoints')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('active', '=', true)
      .execute();

    const q = getWebhookQueue();

    for (const ep of endpoints) {
      // Check if endpoint is subscribed to this event (or all events '*')
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

      await q.add(
        'webhook-send',
        {
          deliveryId: delivery.id,
          url: ep.url,
          secret: ep.secret,
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
