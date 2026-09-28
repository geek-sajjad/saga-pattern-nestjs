import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SERVICES, sqliteFor } from '@app/common';
import { CustomsController } from './customs.controller';
import { CustomsService } from './customs.service';
import { CustomsDeclaration } from './declaration.entity';

@Module({
  imports: [sqliteFor(SERVICES.CUSTOMS, [CustomsDeclaration]), TypeOrmModule.forFeature([CustomsDeclaration])],
  controllers: [CustomsController],
  providers: [CustomsService],
})
export class CustomsModule {}
