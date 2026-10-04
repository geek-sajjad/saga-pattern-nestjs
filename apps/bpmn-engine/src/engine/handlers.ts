import { Injectable } from '@nestjs/common';

/**
 * A **business** error: something the process diagram is expected to handle
 * (vessel full, credit limit reached). The engine routes it to a matching
 * error boundary event on the task.
 *
 * Any other thrown error is a **technical** failure (service down, bug,
 * timeout). The diagram doesn't model those; the engine creates an *incident*
 * and the token waits until an operator retries.
 *
 * This split is the most important design decision when you write workers
 * for Camunda/Zeebe/Flowable: `throw new BpmnError(...)` vs `throw new Error(...)`.
 */
export class BpmnError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export interface HandlerContext {
  instanceId: string;
  nodeId: string;
  /** A copy of the process variables. Return the ones you want to change. */
  variables: Record<string, any>;
}

/** Returned object is merged into the process variables. */
export type TaskHandler = (ctx: HandlerContext) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

/**
 * Maps `mini:handler="ocean.book"` in the diagram to real code.
 *
 * The diagram says WHAT happens and in which order; handlers say HOW. This
 * is the same idea as Camunda's `zeebe:taskDefinition type="..."` (job
 * workers) or Camunda 7's `camunda:delegateExpression`.
 */
@Injectable()
export class HandlerRegistry {
  private readonly handlers = new Map<string, TaskHandler>();

  register(name: string, handler: TaskHandler): void {
    this.handlers.set(name, handler);
  }

  get(name: string): TaskHandler | undefined {
    return this.handlers.get(name);
  }

  names(): string[] {
    return [...this.handlers.keys()].sort();
  }
}
