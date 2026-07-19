import { Controller, Get } from '@nestjs/common';
import { Public } from '@/common/auth.guard';

@Controller('api')
export class HealthController {
  @Public()
  @Get('health')
  getHealth() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'reachpilot-api',
    };
  }
}
