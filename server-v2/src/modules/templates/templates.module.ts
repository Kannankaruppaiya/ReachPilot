import { Module } from '@nestjs/common';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';
import { TemplateWritesController, TemplateWritesService } from './template-writes.controller';
@Module({
  controllers: [TemplatesController, TemplateWritesController],
  providers: [TemplatesService, TemplateWritesService],
  exports: [TemplatesService],
})
export class TemplatesModule {}
