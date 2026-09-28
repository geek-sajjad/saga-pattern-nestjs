import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { CompensateCommand, PATTERNS, SERVICES, slowReplyIfRequested, StepCommand } from '@app/common';
import { TruckingService } from './trucking.service';

@Controller()
export class TruckingController {
  constructor(private readonly service: TruckingService) {}

  @MessagePattern(PATTERNS.TRUCKING.BOOK)
  async book(@Payload() cmd: StepCommand) {
    const result = await this.service.book(cmd);
    await slowReplyIfRequested(SERVICES.TRUCKING, cmd);
    return result;
  }

  @MessagePattern(PATTERNS.TRUCKING.CANCEL)
  cancel(@Payload() cmd: CompensateCommand) {
    return this.service.cancel(cmd);
  }

  @MessagePattern('trucking.list')
  list() {
    return this.service.findAll();
  }
}
