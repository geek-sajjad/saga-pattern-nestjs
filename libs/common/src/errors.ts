import { RpcException } from '@nestjs/microservices';

/** Shape of an error that travels back to the orchestrator over TCP. */
export interface BusinessErrorPayload {
  code: string;
  message: string;
}

/**
 * A business rejection ("vessel is full", "cargo is prohibited", ...).
 * Throwing an RpcException is how a Nest microservice replies with an error.
 */
export function businessError(code: string, message: string): RpcException {
  return new RpcException({ code, message } satisfies BusinessErrorPayload);
}
