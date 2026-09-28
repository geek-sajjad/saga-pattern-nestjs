import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { ORCHESTRATOR_HTTP_PORT } from '@app/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // The live saga UI (plain HTML, no build step).
  app.useStaticAssets(join(process.cwd(), 'apps', 'orchestrator', 'public'));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(ORCHESTRATOR_HTTP_PORT);
  new Logger('orchestrator').log(`forwarder API on http://localhost:${ORCHESTRATOR_HTTP_PORT}/shipments`);
  new Logger('orchestrator').log(`live saga UI on http://localhost:${ORCHESTRATOR_HTTP_PORT}/`);
}
bootstrap();
