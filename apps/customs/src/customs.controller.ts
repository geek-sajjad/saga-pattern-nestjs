import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { CompensateCommand, PATTERNS, SERVICES, slowReplyIfRequested, StepCommand } from '@app/common';
import { CustomsService } from './customs.service';

@Controller()
export class CustomsController {
  constructor(private readonly service: CustomsService) {}

  @MessagePattern(PATTERNS.CUSTOMS.FILE)
  async file(@Payload() cmd: StepCommand) {
    const result = await this.service.file(cmd);
    await slowReplyIfRequested(SERVICES.CUSTOMS, cmd);
    return result;
  }

  @MessagePattern(PATTERNS.CUSTOMS.WITHDRAW)
  withdraw(@Payload() cmd: CompensateCommand) {
    return this.service.withdraw(cmd);
  }

  @MessagePattern('customs.list')
  list() {
    return this.service.findAll();
  }
}
