import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { CompensateCommand, PATTERNS, SERVICES, slowReplyIfRequested, StepCommand } from '@app/common';
import { BillingService } from './billing.service';

@Controller()
export class BillingController {
  constructor(private readonly service: BillingService) {}

  @MessagePattern(PATTERNS.BILLING.CHARGE)
  async charge(@Payload() cmd: StepCommand) {
    const result = await this.service.charge(cmd);
    await slowReplyIfRequested(SERVICES.BILLING, cmd);
    return result;
  }

  @MessagePattern(PATTERNS.BILLING.REFUND)
  refund(@Payload() cmd: CompensateCommand) {
    return this.service.refund(cmd);
  }

  @MessagePattern('billing.list')
  list() {
    return this.service.findAll();
  }
}
