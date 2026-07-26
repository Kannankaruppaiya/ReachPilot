import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { JwtPayload } from './auth.guard';

/**
 * Interceptor that:
 * 1. Extracts workspace_id from the JWT payload and attaches it to the request.
 * 2. Wraps the entire request handler inside a withWorkspace() DB transaction
 *    so that all Kysely queries within the request automatically have the
 *    RLS app.workspace_id session variable set.
 *
 * NOTE: This interceptor sets a transaction-scoped SET LOCAL app.workspace_id.
 * Queries that need a DIFFERENT workspace context (e.g. admin cross-tenant reads)
 * must explicitly call withWorkspace() with the target workspace ID.
 */
@Injectable()
export class WorkspaceInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtPayload | undefined;
    const workspaceId = user?.workspaceId;

    if (workspaceId) {
      request.workspaceId = workspaceId;
    }

    return next.handle();
  }
}
