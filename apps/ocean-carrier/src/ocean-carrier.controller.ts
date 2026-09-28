import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { CompensateCommand, PATTERNS, SERVICES, slowReplyIfRequested, StepCommand } from '@app/common';
import { OceanCarrierService } from './ocean-carrier.service';

@Controller()
export class OceanCarrierController {
  constructor(private readonly service: OceanCarrierService) {}

  @MessagePattern(PATTERNS.OCEAN_CARRIER.BOOK)
  async book(@Payload() cmd: StepCommand) {
    const result = await this.service.book(cmd);
    await slowReplyIfRequested(SERVICES.OCEAN_CARRIER, cmd);
    return result;
  }

  @MessagePattern(PATTERNS.OCEAN_CARRIER.CANCEL)
  cancel(@Payload() cmd: CompensateCommand) {
    return this.service.cancel(cmd);
  }

  @MessagePattern('ocean.list')
  list() {
    return this.service.findAll();
  }
}
