import { BpmnModdle } from 'bpmn-moddle';
import { MINI_MODDLE } from './mini-moddle';

/**
 * What our own code needs to know about a deployed diagram: node names for
 * the cockpit and the history, `mini:` attributes, which task undoes which,
 * and a list of nodes to diff two versions.
 *
 * bpmn-engine parses the same XML again to EXECUTE it; this is only a read
 * model. Both use bpmn-moddle, the parser behind bpmn-js, so the engine and
 * the modeler can never disagree about what a file means.
 */

export type EventKind = 'none' | 'timer' | 'message' | 'error' | 'compensate' | 'terminate' | 'other';

export interface FormField {
  name: string;
  type: 'string' | 'number' | 'boolean';
}

/** `<bpmn:message name="VesselArrived" mini:correlationKey="${shipmentRef}"/>` */
export interface MessageRef {
  /** The `id` of `<bpmn:message>`: what bpmn-engine is signalled with. */
  id: string;
  /** The `name`: what the outside world sends (`POST /api/messages {name}`). */
  name: string;
  /** Expression evaluated when a token starts waiting; an incoming message must carry the same key. */
  correlationKey?: string;
}

/** `<bpmn:multiInstanceLoopCharacteristics mini:collection="${containerList}" mini:elementVariable="container" …/>` */
export interface LoopInfo {
  sequential: boolean;
  collection?: string;
  elementVariable: string;
  outputCollection?: string;
  outputElement?: string;
}

/** How a call activity picks the version of the process it calls (Camunda 7: `camunda:calledElementBinding`). */
export type CalledElementBinding = 'latest' | 'version' | 'versionTag';

export interface CallInfo {
  calledElement: string;
  binding: CalledElementBinding;
  /** For binding = version / versionTag. May be an expression, e.g. `${customsRelease}`. */
  calledVersion?: string;
  /** Variables copied into the child (undefined = all) and back out of it (undefined = all). */
  inputs?: string[];
  outputs?: string[];
}

export interface NodeInfo {
  id: string;
  /** `serviceTask`, `userTask`, `boundaryEvent`, … (the BPMN element name). */
  type: string;
  name?: string;
  /** The sub-process this node lives in (undefined = the process itself). */
  parentId?: string;
  incoming: string[];
  outgoing: string[];
  handler?: string;
  formFields?: FormField[];
  eventKind?: EventKind;
  message?: MessageRef;
  attachedTo?: string;
  interrupting?: boolean;
  isForCompensation?: boolean;
  /** Activity: id of the task that undoes it (compensation boundary event + association). */
  compensatedBy?: string;
  loop?: LoopInfo;
  call?: CallInfo;
}

export interface FlowInfo {
  id: string;
  name?: string;
  sourceRef: string;
  targetRef: string;
}

export interface ProcessModel {
  /** The `id` of `<bpmn:process>`. Starting "the latest version of key X" is how engines are used. */
  key: string;
  name: string;
  /** Business label for this version (`mini:versionTag` on the process), e.g. "2026.2". */
  versionTag?: string;
  nodes: Record<string, NodeInfo>;
  flows: Record<string, FlowInfo>;
}

export class BpmnValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid BPMN:\n - ${problems.join('\n - ')}`);
  }
}

/** Activity types: they can be compensated and can carry boundary events. */
export const ACTIVITY_TYPES = ['task', 'serviceTask', 'userTask', 'receiveTask', 'manualTask', 'subProcess', 'callActivity'];

/**
 * Elements bpmn-engine could run but this app can't wire to code: script tasks
 * would run JavaScript from the diagram, the others have no `mini:handler`.
 */
const UNSUPPORTED = ['scriptTask', 'sendTask', 'businessRuleTask', 'transaction', 'adHocSubProcess', 'complexGateway'];

const moddle = new BpmnModdle({ mini: MINI_MODDLE });
const typeName = (bo: any) => String(bo.$type).replace(/^bpmn:/, '').replace(/^./, (c) => c.toLowerCase());
const list = (v: string | undefined) => (v === undefined ? undefined : v.split(',').map((s) => s.trim()).filter(Boolean));

function eventKind(bo: any): EventKind | undefined {
  const def = bo.eventDefinitions?.[0];
  if (!bo.$type.endsWith('Event')) return undefined;
  if (!def) return 'none';
  const kind = typeName(def).replace(/EventDefinition$/, '');
  return (['timer', 'message', 'error', 'compensate', 'terminate'].includes(kind) ? kind : 'other') as EventKind;
}

function messageOf(ref: any): MessageRef | undefined {
  return ref ? { id: ref.id, name: ref.name ?? ref.id, correlationKey: ref.correlationKey } : undefined;
}

function parseFormFields(spec: string): FormField[] {
  return spec.split(',').map((part) => {
    const [name, type = 'string'] = part.split(':').map((s) => s.trim());
    return { name, type: (['string', 'number', 'boolean'].includes(type) ? type : 'string') as FormField['type'] };
  });
}

/** Parse and validate a BPMN file. Throws BpmnValidationError with every problem found. */
export async function readProcessModel(xml: string): Promise<ProcessModel> {
  let parsed: Awaited<ReturnType<BpmnModdle['fromXML']>>;
  try {
    parsed = await moddle.fromXML(xml);
  } catch (err) {
    throw new BpmnValidationError([`not a BPMN 2.0 file: ${err instanceof Error ? err.message : err}`]);
  }
  const definitions = parsed.rootElement;
  const problems = parsed.warnings.map((w) => w.message);
  const processes = (definitions.rootElements ?? []).filter((e: any) => e.$type === 'bpmn:Process');
  const proc = processes.find((p: any) => p.isExecutable) ?? processes[0];
  if (!proc) throw new BpmnValidationError(['no <bpmn:process> found']);
  if (processes.length > 1) problems.push('only one <bpmn:process> per file is supported (no collaborations)');

  const nodes: Record<string, NodeInfo> = {};
  const flows: Record<string, FlowInfo> = {};
  const associations: any[] = [];

  // A sub-process is a graph inside the graph: read each level the same way.
  const readScope = (container: any, parentId?: string) => {
    for (const bo of container.flowElements ?? []) {
      const type = typeName(bo);
      if (type === 'sequenceFlow') {
        flows[bo.id] = { id: bo.id, name: bo.name, sourceRef: bo.sourceRef?.id, targetRef: bo.targetRef?.id };
        continue;
      }
      if (UNSUPPORTED.includes(type)) problems.push(`${type} "${bo.name ?? bo.id}" is not supported here (there is no mini:handler for it)`);
      const loop = bo.loopCharacteristics;
      if (loop && loop.$type !== 'bpmn:MultiInstanceLoopCharacteristics') problems.push(`"${bo.name ?? bo.id}": standard loops are not supported, use multi-instance`);
      nodes[bo.id] = {
        id: bo.id,
        type,
        name: bo.name,
        parentId,
        incoming: [],
        outgoing: [],
        handler: bo.handler,
        formFields: bo.formFields ? parseFormFields(bo.formFields) : undefined,
        eventKind: eventKind(bo),
        message: messageOf(type === 'receiveTask' ? bo.messageRef : bo.eventDefinitions?.[0]?.messageRef),
        attachedTo: bo.attachedToRef?.id,
        interrupting: type === 'boundaryEvent' ? bo.cancelActivity !== false : undefined,
        isForCompensation: bo.isForCompensation || undefined,
        loop:
          loop?.$type === 'bpmn:MultiInstanceLoopCharacteristics'
            ? { sequential: !!loop.isSequential, collection: loop.collection, elementVariable: loop.elementVariable ?? 'item', outputCollection: loop.outputCollection, outputElement: loop.outputElement }
            : undefined,
        call:
          type === 'callActivity'
            ? {
                calledElement: bo.calledElement,
                binding: (bo.calledElementBinding ?? 'latest') as CalledElementBinding,
                calledVersion: bo.calledElementVersion ?? bo.calledElementVersionTag,
                inputs: list(bo.inputs),
                outputs: list(bo.outputs),
              }
            : undefined,
      };
      if (type === 'subProcess') readScope(bo, bo.id);
    }
    associations.push(...(container.artifacts ?? []).filter((a: any) => a.$type === 'bpmn:Association'));
  };
  readScope(proc);

  for (const flow of Object.values(flows)) {
    nodes[flow.sourceRef]?.outgoing.push(flow.id);
    nodes[flow.targetRef]?.incoming.push(flow.id);
  }
  // Compensation: a compensation boundary event on activity A is linked by an
  // *association* (dotted line, not a sequence flow) to the task that undoes A.
  for (const assoc of associations) {
    const boundary = nodes[assoc.sourceRef?.id];
    const undo = nodes[assoc.targetRef?.id];
    if (boundary?.eventKind === 'compensate' && boundary.attachedTo && undo) nodes[boundary.attachedTo].compensatedBy = undo.id;
  }

  problems.push(...validate(nodes, flows, definitions));
  if (problems.length) throw new BpmnValidationError(problems);
  return { key: proc.id, name: proc.name ?? proc.id, versionTag: proc.versionTag, nodes, flows };
}

/**
 * The checks a modeler's linter would show as red squiggles. bpmn-engine
 * would run most of these diagrams anyway and fail at runtime; refusing them
 * at deploy time gives a better error.
 */
function validate(nodes: Record<string, NodeInfo>, flows: Record<string, FlowInfo>, definitions: any): string[] {
  const problems: string[] = [];
  const label = (n: NodeInfo) => `${n.type} "${n.name ?? n.id}"`;
  const timerDefined = (id: string) => {
    const def = findElement(definitions, id)?.eventDefinitions?.[0];
    return !!(def?.timeDuration?.body || def?.timeDate?.body || def?.timeCycle?.body);
  };

  for (const n of Object.values(nodes)) {
    if (!n.isForCompensation && !['startEvent', 'boundaryEvent'].includes(n.type) && !n.incoming.length) problems.push(`${label(n)} is unreachable (no incoming flow)`);
    if (n.type === 'serviceTask' && !n.handler) problems.push(`${label(n)} needs a mini:handler attribute`);
    if (n.eventKind === 'timer' && !timerDefined(n.id)) problems.push(`${label(n)} needs a timeDuration, timeDate or timeCycle (e.g. PT10S)`);
    if ((n.eventKind === 'message' || n.type === 'receiveTask') && !n.message) problems.push(`${label(n)} needs a messageRef pointing at a <bpmn:message name="…">`);
    if (n.type === 'boundaryEvent' && !nodes[n.attachedTo ?? '']) problems.push(`${label(n)} is not attached to a known activity`);
    if (n.loop && !n.loop.collection) problems.push(`${label(n)}: multi-instance needs mini:collection, e.g. \${containerList}`);
    if (n.loop?.outputElement && !n.loop.outputCollection) problems.push(`${label(n)}: mini:outputElement needs mini:outputCollection`);
    if (n.call) {
      if (!n.call.calledElement) problems.push(`${label(n)} needs calledElement="<process key>"`);
      if (!['latest', 'version', 'versionTag'].includes(n.call.binding)) problems.push(`${label(n)}: mini:calledElementBinding must be latest, version or versionTag`);
      if (n.call.binding !== 'latest' && !n.call.calledVersion) problems.push(`${label(n)}: binding "${n.call.binding}" needs mini:calledElement${n.call.binding === 'version' ? 'Version' : 'VersionTag'}`);
    }
    if (n.type === 'exclusiveGateway' && n.outgoing.length > 1) {
      const gateway = findElement(definitions, n.id);
      const unguarded = n.outgoing.filter((id) => !findElement(definitions, id)?.conditionExpression && gateway?.default?.id !== id);
      if (unguarded.length) problems.push(`${label(n)}: flows ${unguarded.join(', ')} need a condition or must be the default flow`);
    }
  }
  for (const f of Object.values(flows)) {
    if (!nodes[f.sourceRef] || !nodes[f.targetRef]) problems.push(`sequence flow ${f.id} connects unknown elements (${f.sourceRef} → ${f.targetRef})`);
  }
  return problems;
}

/** Find a moddle element anywhere in the process tree by id. */
function findElement(definitions: any, id: string): any {
  const queue = [...(definitions.rootElements ?? [])];
  while (queue.length) {
    const el = queue.shift();
    if (el.id === id) return el;
    queue.push(...(el.flowElements ?? []));
  }
  return undefined;
}
