import { DynamicModule, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import { SERVICE_PORTS, ServiceName } from './services';

/** Database-per-service: each participant owns its own SQLite file. */
export function sqliteFor(service: string, entities: Function[]): DynamicModule {
  return TypeOrmModule.forRoot({
    type: 'better-sqlite3',
    database: join(process.cwd(), 'data', `${service}.sqlite`),
    entities,
    synchronize: true, // fine for a demo, use migrations in real life
  });
}

/** Start a participant as a NestJS TCP microservice. */
export async function bootstrapParticipant(module: unknown, service: ServiceName): Promise<void> {
  const port = SERVICE_PORTS[service];
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(module as never, {
    transport: Transport.TCP,
    options: { host: '127.0.0.1', port },
  });
  await app.listen();
  new Logger(service).log(`listening on tcp://127.0.0.1:${port}`);
}
