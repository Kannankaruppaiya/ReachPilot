import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { JwtPayload } from './auth.guard';

/**
 * Attaches the JWT's workspace_id to the request and runs the handler inside
 * withWorkspace(). A different workspace needs an explicit withWorkspace() call.
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
