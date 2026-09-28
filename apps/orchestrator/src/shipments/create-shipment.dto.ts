import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Max, Min, ValidateNested } from 'class-validator';
import { ContainerType, FailureSimulation, SERVICE_PORTS, ServiceName } from '@app/common';

const SERVICE_NAMES = Object.keys(SERVICE_PORTS) as ServiceName[];

export class FailureSimulationDto implements FailureSimulation {
  @IsOptional() @IsIn(SERVICE_NAMES)
  failAt?: ServiceName;

  @IsOptional() @IsIn(SERVICE_NAMES)
  slowReplyAt?: ServiceName;

  @IsOptional() @IsIn(SERVICE_NAMES)
  flakyCompensationAt?: ServiceName;
}

/** Every field has a sensible default, so `POST /shipments {}` already works. */
export class CreateShipmentDto {
  @IsOptional() @IsString()
  customerId?: string;

  @IsOptional() @IsInt() @Min(1) @Max(100)
  containers?: number;

  @IsOptional() @IsIn(['20GP', '40GP', '40HC'])
  containerType?: ContainerType;

  @IsOptional() @IsString() @Length(5, 5)
  originPort?: string;

  @IsOptional() @IsString() @Length(5, 5)
  destinationPort?: string;

  @IsOptional() @IsString()
  finalDestinationCity?: string;

  @IsOptional() @IsString()
  cargoDescription?: string;

  @IsOptional() @IsString() @Length(6, 10)
  hsCode?: string;

  @IsOptional() @IsNumber() @Min(0)
  cargoValueEur?: number;

  @IsOptional() @ValidateNested() @Type(() => FailureSimulationDto)
  simulate?: FailureSimulationDto;
}
