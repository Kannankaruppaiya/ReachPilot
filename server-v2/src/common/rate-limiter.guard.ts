import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import Redis from 'ioredis';
import { getEnv } from '@/config/env';

export const RATE_LIMIT_KEY = 'rateLimit';

export interface RateLimitOptions {
  max: number;
  windowMs: number;
  keyPrefix?: string;
}

export const RateLimit = (options: RateLimitOptions) =>
  SetMetadata(RATE_LIMIT_KEY, options);

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (redisClient) return redisClient;
  const env = getEnv();
  redisClient = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return redisClient;
}

/**
 * Redis-backed sliding window rate limiter.
 * Applies to routes decorated with @RateLimit({ max, windowMs }).
 */
@Injectable()
export class RateLimiterGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.get<RateLimitOptions | undefined>(
      RATE_LIMIT_KEY,
      context.getHandler(),
    );

    if (!options) return true;

    const request = context.switchToHttp().getRequest();
    const ip = request.ip || request.socket?.remoteAddress || 'unknown';
    const route = request.route?.path || request.url;
    const prefix = options.keyPrefix || 'rl';
    const key = `${prefix}:${route}:${ip}`;

    const redis = getRedis();
    const now = Date.now();
    const windowStart = now - options.windowMs;

    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(key, '-inf', String(windowStart));
    pipeline.zcard(key);
    pipeline.zadd(key, String(now), String(now) + ':' + Math.random().toString(36).slice(2, 8));
    pipeline.pexpire(key, options.windowMs);
    const results = await pipeline.exec();

    const count = results?.[1]?.[1] as number;
    if (count >= options.max) {
      throw new HttpException(
        'Too many requests. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
