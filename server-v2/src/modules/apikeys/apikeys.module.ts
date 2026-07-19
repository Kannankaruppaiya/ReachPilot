import { Module } from '@nestjs/common';
import { ApiKeysController } from './apikeys.controller';
import { ApiKeysService } from './apikeys.service';

@Module({
  controllers: [ApiKeysController],
  providers: [ApiKeysService],
  exports: [ApiKeysService],
})
export class ApiKeysModule {}
