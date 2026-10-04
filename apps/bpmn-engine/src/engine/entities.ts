import { Column, CreateDateColumn, Entity, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * A deployed BPMN file. Deploying the same process key again creates a NEW
 * version; running instances keep using the version they started with.
 * (Camunda: ACT_RE_PROCDEF + ACT_GE_BYTEARRAY.)
 */
@Entity('deployments')
export class Deployment {
  @PrimaryGeneratedColumn()
  id: number;

  /** The `id` of `<bpmn:process>`. */
  @Column()
  key: string;

  @Column()
  version: number;

  @Column()
  name: string;

  /**
   * A business label for the version (`mini:versionTag="2026.2"` on the process).
   * Version numbers are assigned by the engine; tags are chosen by people, so
   * a caller can pin "the 2026.2 release" without knowing it became v7 here.
   */
  @Column({ type: 'varchar', nullable: true })
  versionTag: string | null;

  @Column('text')
  xml: string;

  @CreateDateColumn()
  deployedAt: Date;
}

/**
 * Something an instance is busy with or waiting for, as bpmn-engine reported
 * it through its events. bpmn-engine keeps the real execution state in its own
 * snapshot (`engineState`); this list is our readable copy for the cockpit and
 * for routing messages, user task completions and called instances back in.
 */
export interface Wait {
  /** bpmn-engine's execution id. Signals go to it; the REST API calls it the token id. */
  executionId: string;
  nodeId: string;
  /**
   * executing → a handler runs right now (if we crash here, it runs again after the restart)
   * user      → a user task waits for a person
   * message   → a receive task, message catch event or message boundary event waits for a message
   * timer     → a timer catch event or timer boundary event is set
   * call      → a call activity waits for the instance it started
   * join      → a parallel join waits for its other branches
   */
  kind: 'executing' | 'user' | 'message' | 'timer' | 'call' | 'join';
  /** Multi-instance iteration: the execution id of the loop it belongs to, its index and item. */
  scopeId?: string;
  iteration?: { index: number; item: unknown };
  /** Messages: the `<bpmn:message>` id to signal, its name, and the key an incoming message must carry. */
  messageId?: string;
  messageName?: string;
  correlationKey?: string;
  /** Timers: when they fire (epoch ms). */
  dueAt?: number;
  /** Boundary events: does firing cancel the activity they sit on? */
  interrupting?: boolean;
  /** Call activity: the instance it waits for. */
  childInstanceId?: string;
}

/** A technical failure the diagram doesn't model: the activity stays parked until an operator retries. */
export interface Incident {
  executionId: string;
  nodeId: string;
  message: string;
  at: string;
}

/** One line of the audit trail. (Camunda: the ACT_HI_* history tables.) */
export interface HistoryEntry {
  at: string;
  type:
    | 'instance-started' | 'node-entered' | 'node-completed' | 'task-completed' | 'flow-taken' | 'waiting'
    | 'timer-fired' | 'message-received' | 'called' | 'error-caught'
    | 'incident' | 'incident-retried' | 'compensation-started' | 'compensated' | 'variables-changed'
    | 'instance-completed' | 'instance-terminated' | 'instance-cancelled';
  nodeId?: string;
  flowId?: string;
  tokenId?: string;
  message: string;
}

export interface CompletedActivity {
  nodeId: string;
  at: string;
  /** Set once its compensation handler ran, so compensation never runs twice. */
  compensated?: boolean;
}

/**
 * One execution of a process. bpmn-engine runs it in memory; after every
 * event the engine saves bpmn-engine's snapshot (`engineState`) together with
 * our own bookkeeping, and on restart rebuilds the instance from that row.
 * (Camunda: ACT_RU_EXECUTION, ACT_RU_TASK, ACT_RU_VARIABLE, ACT_RU_JOB.)
 */
@Entity('process_instances')
export class ProcessInstance {
  @PrimaryColumn()
  id: string;

  @Column()
  definitionKey: string;

  @Column()
  definitionVersion: number;

  /** TERMINATED = ended by an error nobody caught (for a called instance, the error goes to the calling process). */
  @Column({ type: 'varchar' })
  status: 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'TERMINATED';

  /** Set when a call activity started this instance. (Camunda: SUPER_PROCESS_INSTANCE_ID_.) */
  @Column({ type: 'varchar', nullable: true })
  parentInstanceId: string | null;

  /** The execution id of the parent's call activity that waits for this instance. */
  @Column({ type: 'varchar', nullable: true })
  parentExecutionId: string | null;

  /** Why a TERMINATED instance ended. */
  @Column({ type: 'simple-json', nullable: true })
  endError: { code: string; message: string } | null;

  /** bpmn-engine's `getState()` snapshot: where every token is, timers, loop counters. Opaque to us. */
  @Column({ type: 'simple-json', nullable: true })
  engineState: object | null;

  @Column('simple-json')
  waits: Wait[];

  @Column('simple-json')
  incidents: Incident[];

  /** Process variables: the data that flows through the process. */
  @Column('simple-json')
  variables: Record<string, any>;

  /** Activities that finished, in order. Compensation walks this list backwards. */
  @Column('simple-json')
  completed: CompletedActivity[];

  @Column('simple-json')
  history: HistoryEntry[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
