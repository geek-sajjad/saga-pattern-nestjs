/**
 * The in-memory process model: what the parser builds from BPMN XML and
 * what the engine walks at runtime.
 *
 * A BPMN process is a directed graph:
 *  - **flow nodes** (events, activities, gateways) are the vertices,
 *  - **sequence flows** are the edges ("after this, go there").
 *
 * Sub-processes nest graphs inside graphs. We keep ONE flat map of nodes and
 * remember each node's `parentId` (the sub-process it lives in), because BPMN
 * ids are unique across the whole file anyway.
 *
 * The engine never looks at the XML again after parsing. Real engines do the
 * same: Camunda turns the XML into a "process definition" object graph once,
 * at deployment time, and caches it.
 */

/** The BPMN element types this mini engine knows how to execute. */
export const SUPPORTED_NODE_TYPES = [
  'startEvent',
  'endEvent',
  'task',
  'serviceTask',
  'userTask',
  'receiveTask',
  'subProcess',
  'callActivity',
  'exclusiveGateway',
  'parallelGateway',
  'eventBasedGateway',
  'intermediateCatchEvent',
  'intermediateThrowEvent',
  'boundaryEvent',
] as const;

export type NodeType = (typeof SUPPORTED_NODE_TYPES)[number];

/** Node types that are "activities": they can carry boundary events and multi-instance markers. */
export const ACTIVITY_TYPES: readonly NodeType[] = ['task', 'serviceTask', 'userTask', 'receiveTask', 'subProcess', 'callActivity'];

/** Which event definition an event carries (`<bpmn:timerEventDefinition/>` → 'timer'). */
export type EventKind = 'none' | 'timer' | 'message' | 'error' | 'compensate' | 'terminate';

export interface FormField {
  name: string;
  type: 'string' | 'number' | 'boolean';
}

/** `<bpmn:message name="VesselArrived" mini:correlationKey="${shipmentRef}"/>` */
export interface MessageRef {
  name: string;
  /** Expression evaluated when the token starts waiting; an incoming message must carry the same key. */
  correlationKey?: string;
}

/**
 * `<bpmn:multiInstanceLoopCharacteristics>`: run the activity once per item of a list.
 * (Camunda 8: `zeebe:loopCharacteristics inputCollection=… inputElement=…`.)
 */
export interface LoopCharacteristics {
  sequential: boolean;
  /** Expression that yields an array, e.g. `${containerList}`. */
  collection: string;
  /** Name under which each iteration sees its item. */
  elementVariable: string;
  /** Collect one result per iteration into this process variable… */
  outputCollection?: string;
  /** …computed by this expression over the iteration's variables (default: what the iteration produced). */
  outputElement?: string;
}

/**
 * How a call activity picks the version of the process it calls.
 * (Camunda 7: `camunda:calledElementBinding`.)
 *  - latest     → whatever is newest when the call happens
 *  - version    → an exact version number
 *  - versionTag → the newest deployment carrying a business label, e.g. "2026.2"
 */
export type CalledElementBinding = 'latest' | 'version' | 'versionTag';

export interface FlowNode {
  id: string;
  type: NodeType;
  name?: string;
  /** The sub-process this node lives in (undefined = the process itself). */
  parentId?: string;
  /** Ids of incoming / outgoing sequence flows. */
  incoming: string[];
  outgoing: string[];

  /** serviceTask: name of the code to run, from the `mini:handler` extension attribute. */
  handler?: string;
  /** userTask: fields the UI shows, from `mini:formFields="approved:boolean,comment:string"`. */
  formFields?: FormField[];
  /** exclusiveGateway: flow taken when no condition matches. */
  defaultFlow?: string;

  /** Events: which event definition they carry. */
  eventKind?: EventKind;
  /** Timer events: ISO-8601 duration, e.g. PT10S. */
  timerDuration?: string;
  /** Error events: the error code thrown (end event) or caught (boundary; undefined = catch all). */
  errorCode?: string;
  /** Message events and receive tasks: the message they wait for. */
  message?: MessageRef;

  /** boundaryEvent: the activity it is attached to. */
  attachedTo?: string;
  /** boundaryEvent: interrupting (default) cancels the activity; non-interrupting runs alongside it. */
  interrupting?: boolean;
  /** Boundary events attached to this activity. */
  boundaryEvents: string[];

  /** A compensation handler is not part of the normal flow: it only runs to undo something. */
  isForCompensation?: boolean;
  /** Activity: id of the task that undoes it (linked via compensation boundary + association). */
  compensatedBy?: string;

  /** subProcess: its own start event. */
  startNodeId?: string;

  /** Multi-instance activity. */
  loop?: LoopCharacteristics;

  /** callActivity: the process key it starts, and how the version is chosen. */
  calledElement?: string;
  binding?: CalledElementBinding;
  /** For binding = version / versionTag. May be an expression, e.g. `${customsRelease}`. */
  calledVersion?: string;
  /** callActivity: variables copied into the child (undefined = all) and back out of it (undefined = all). */
  inputs?: string[];
  outputs?: string[];
}

export interface SequenceFlow {
  id: string;
  name?: string;
  sourceRef: string;
  targetRef: string;
  /** `${...}` expression; the flow is only taken if it evaluates to true. */
  condition?: string;
}

export interface ProcessDefinition {
  /** The `id` of `<bpmn:process>`. Starting "the latest version of key X" is how engines are used. */
  key: string;
  name: string;
  version: number;
  /** Business label for this version (`mini:versionTag` on the process), e.g. "2026.2". */
  versionTag?: string;
  startNodeId: string;
  nodes: Record<string, FlowNode>;
  flows: Record<string, SequenceFlow>;
}
