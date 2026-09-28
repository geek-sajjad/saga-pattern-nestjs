import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { CompensateCommand, PATTERNS, SERVICES, slowReplyIfRequested, StepCommand } from '@app/common';
import { WarehouseService } from './warehouse.service';

@Controller()
export class WarehouseController {
  constructor(private readonly service: WarehouseService) {}

  @MessagePattern(PATTERNS.WAREHOUSE.RESERVE)
  async reserve(@Payload() cmd: StepCommand) {
    const result = await this.service.reserve(cmd);
    await slowReplyIfRequested(SERVICES.WAREHOUSE, cmd);
    return result;
  }

  @MessagePattern(PATTERNS.WAREHOUSE.RELEASE)
  release(@Payload() cmd: CompensateCommand) {
    return this.service.release(cmd);
  }

  @MessagePattern('warehouse.list')
  list() {
    return this.service.findAll();
  }
}
