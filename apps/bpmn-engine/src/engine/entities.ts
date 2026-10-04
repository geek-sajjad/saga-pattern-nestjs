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
 * Something a waiting token listens for. (Camunda: event subscriptions and timer jobs.)
 * A user task with a reminder timer and an "address changed" message boundary
 * has two subscriptions; whichever fires first decides what happens.
 */
export interface Subscription {
  kind: 'timer' | 'message';
  /** The event that fires: the catch event itself, a boundary event, or an event after an event-based gateway. */
  eventId: string;
  /** Timers: when to fire (epoch ms). */
  dueAt?: number;
  /** Messages: the name and the correlation key an incoming message must carry. */
  messageName?: string;
  correlationKey?: string;
  /** Boundary events only: does firing cancel the activity? */
  interrupting?: boolean;
}

/**
 * A token marks "where execution currently is". A process instance can have
 * several tokens at once (after a parallel gateway forks).
 *
 * Tokens form a tree through `scopeId`. A token that enters a sub-process
 * stays on the sub-process node (WAITING) and a child token starts inside it.
 * A multi-instance activity works the same way: the arriving token becomes
 * the "body" and one child token per item runs the activity.
 */
export interface Token {
  id: string;
  nodeId: string;
  /** The sequence flow the token arrived through (a parallel join counts these). */
  viaFlow?: string;
  /**
   * READY      → the engine should execute the node now
   * EXECUTING  → a service task's handler is running (if we crash here, it re-runs on restart)
   * WAITING    → a wait state: user/receive task, timer, message, join, sub-process, call activity, loop body
   * INCIDENT   → a technical failure; needs a human to fix the cause and click "retry"
   */
  state: 'READY' | 'EXECUTING' | 'WAITING' | 'INCIDENT';
  /** The token that owns this one's scope (a sub-process token or a multi-instance body). Unset = process level. */
  scopeId?: string;
  /** Variables only this token and its children see (a multi-instance item and its loopCounter). */
  locals?: Record<string, any>;
  /** Timers and messages this waiting token listens for. */
  subscriptions?: Subscription[];
  /** Multi-instance body: the items, and what each finished iteration produced. */
  loop?: { items: unknown[]; started: number; finished: number; results: unknown[] };
  /** Multi-instance iteration: which item this token works on. */
  loopIndex?: number;
  /** Call activity: the child process instance this token waits for. */
  childInstanceId?: string;
  /** @deprecated timers live in `subscriptions`; only read to upgrade instances saved by older versions. */
  dueAt?: number;
  incident?: string;
}

/** One line of the audit trail. (Camunda: the ACT_HI_* history tables.) */
export interface HistoryEntry {
  at: string;
  type:
    | 'instance-started' | 'node-entered' | 'node-completed' | 'flow-taken' | 'waiting'
    | 'timer-fired' | 'message-received' | 'called' | 'loop-started'
    | 'error-caught' | 'error-propagated' | 'incident' | 'incident-retried' | 'compensation-started' | 'compensated'
    | 'variables-changed' | 'migrated'
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
  /** Multi-instance iterations: the item it worked on, so the undo knows WHICH one to undo. */
  locals?: Record<string, any>;
}

/**
 * The runtime state of one execution of a process. The engine loads it,
 * moves tokens, and saves it after EVERY step, exactly like the saga log in
 * the orchestrator: the database row is the source of truth, not memory.
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

  /** TERMINATED = ended by a BPMN error nobody inside caught; the error was handed to the parent process. */
  @Column({ type: 'varchar' })
  status: 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'TERMINATED';

  /** Set when a call activity started this instance. (Camunda: SUPER_PROCESS_INSTANCE_ID_.) */
  @Column({ type: 'varchar', nullable: true })
  parentInstanceId: string | null;

  /** The parent's call-activity token that waits for this instance. */
  @Column({ type: 'varchar', nullable: true })
  parentTokenId: string | null;

  /** Why a TERMINATED instance ended: the error the parent's call activity has to deal with. */
  @Column({ type: 'simple-json', nullable: true })
  endError: { code: string; message: string } | null;

  @Column('simple-json')
  tokens: Token[];

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
