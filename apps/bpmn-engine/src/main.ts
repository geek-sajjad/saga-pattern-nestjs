import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';

export const BPMN_HTTP_PORT = Number(process.env.BPMN_PORT ?? 3200);

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useBodyParser('json', { limit: '2mb' }); // BPMN files with diagram info get big
  // Modeler + instance viewer (plain HTML with bpmn-js from a CDN, no build step).
  app.useStaticAssets(join(process.cwd(), 'apps', 'bpmn-engine', 'public'));
  await app.listen(BPMN_HTTP_PORT);
  new Logger('bpmn-engine').log(`BPMN tool on http://localhost:${BPMN_HTTP_PORT}/ (API under /api)`);
}
bootstrap();
