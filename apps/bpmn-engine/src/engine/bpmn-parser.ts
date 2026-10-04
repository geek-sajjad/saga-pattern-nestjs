import { XMLParser } from 'fast-xml-parser';
import {
  ACTIVITY_TYPES,
  CalledElementBinding,
  EventKind,
  FlowNode,
  FormField,
  LoopCharacteristics,
  MessageRef,
  NodeType,
  ProcessDefinition,
  SequenceFlow,
  SUPPORTED_NODE_TYPES,
} from './model';

/** BPMN elements we recognise but can't execute. Deploying them is an error, not a silent no-op. */
const UNSUPPORTED = [
  'scriptTask', 'sendTask', 'manualTask', 'businessRuleTask', 'transaction', 'adHocSubProcess',
  'inclusiveGateway', 'complexGateway',
];

export class BpmnValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid BPMN:\n - ${problems.join('\n - ')}`);
  }
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // `bpmn:serviceTask` → `serviceTask`, `mini:handler` → `handler`.
  // A real engine resolves namespaces properly; for learning, prefixes are noise.
  removeNSPrefix: true,
  textNodeName: '#text',
  parseAttributeValue: false,
  // These elements may appear once or many times; always give us an array.
  isArray: (name) => [...SUPPORTED_NODE_TYPES, ...UNSUPPORTED, 'sequenceFlow', 'association', 'process', 'error', 'message'].includes(name),
});

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: any): string | undefined => (v === undefined ? undefined : typeof v === 'object' ? v['#text'] : String(v))?.trim();
const list = (v: string | undefined) => (v === undefined ? undefined : v.split(',').map((s) => s.trim()).filter(Boolean));

/** Lookup tables for things defined once at the top of the file and referenced by id. */
interface Refs {
  errorCodes: Map<string, string>;
  messages: Map<string, MessageRef>;
}

/**
 * Step 1 of every BPMN engine: turn the XML into a graph, and refuse anything
 * that can't run. The diagram part (`<bpmndi:BPMNDiagram>`, the x/y
 * coordinates) is ignored; only the modeler and the viewer need it.
 */
export function parseBpmn(source: string, version = 0): ProcessDefinition {
  const doc = xml.parse(source);
  const definitions = doc.definitions;
  if (!definitions) throw new BpmnValidationError(['root element must be <bpmn:definitions>']);

  const processes = asArray<any>(definitions.process);
  const proc = processes.find((p) => p.isExecutable !== 'false') ?? processes[0];
  if (!proc) throw new BpmnValidationError(['no <bpmn:process> found']);

  // <bpmn:error id="Error_Rejected" errorCode="BOOKING_REJECTED"/> and
  // <bpmn:message id="Msg_X" name="VesselArrived"/> live at the top level.
  const refs: Refs = {
    errorCodes: new Map(asArray<any>(definitions.error).map((e) => [e.id, e.errorCode ?? e.id])),
    messages: new Map(asArray<any>(definitions.message).map((m) => [m.id, { name: m.name ?? m.id, correlationKey: m.correlationKey }])),
  };

  const problems: string[] = [];
  const nodes: Record<string, FlowNode> = {};
  const flows: Record<string, SequenceFlow> = {};
  const associations: any[] = [];

  // A sub-process is a graph inside the graph: parse each level the same way.
  const parseScope = (container: any, parentId?: string) => {
    for (const type of UNSUPPORTED) {
      for (const el of asArray<any>(container[type])) problems.push(`${type} "${el.name ?? el.id}" is not supported by this mini engine`);
    }
    for (const type of SUPPORTED_NODE_TYPES) {
      for (const el of asArray<any>(container[type])) {
        if (type === 'subProcess' && el.triggeredByEvent === 'true') {
          problems.push(`event sub-process "${el.name ?? el.id}" is not supported by this mini engine`);
          continue;
        }
        if ('standardLoopCharacteristics' in el) problems.push(`"${el.name ?? el.id}": standard loops are not supported, use multi-instance`);
        nodes[el.id] = {
          id: el.id,
          type: type as NodeType,
          name: el.name,
          parentId,
          incoming: [],
          outgoing: [],
          boundaryEvents: [],
          handler: el.handler,
          formFields: el.formFields ? parseFormFields(el.formFields) : undefined,
          defaultFlow: el.default,
          attachedTo: el.attachedToRef,
          interrupting: type === 'boundaryEvent' ? el.cancelActivity !== 'false' : undefined,
          isForCompensation: el.isForCompensation === 'true',
          loop: parseLoop(el),
          ...(type === 'receiveTask' ? { message: el.messageRef ? refs.messages.get(el.messageRef) : undefined } : {}),
          ...(type === 'callActivity' ? parseCallActivity(el) : {}),
          ...parseEventDefinition(el, refs),
        };
        if (type === 'subProcess') parseScope(el, el.id);
      }
    }
    for (const el of asArray<any>(container.sequenceFlow)) {
      flows[el.id] = { id: el.id, name: el.name, sourceRef: el.sourceRef, targetRef: el.targetRef, condition: text(el.conditionExpression) };
    }
    associations.push(...asArray<any>(container.association));
  };
  parseScope(proc);

  // Wire the graph. We derive incoming/outgoing from the flows instead of
  // trusting the optional <bpmn:incoming>/<bpmn:outgoing> children.
  for (const flow of Object.values(flows)) {
    const source = nodes[flow.sourceRef];
    const target = nodes[flow.targetRef];
    if (!source || !target) {
      problems.push(`sequence flow ${flow.id} connects unknown elements (${flow.sourceRef} → ${flow.targetRef})`);
      continue;
    }
    if (source.parentId !== target.parentId) problems.push(`sequence flow ${flow.id} crosses a sub-process border; flows stay inside their scope`);
    source.outgoing.push(flow.id);
    target.incoming.push(flow.id);
  }

  for (const node of Object.values(nodes)) {
    if (node.type !== 'boundaryEvent') continue;
    const host = node.attachedTo && nodes[node.attachedTo];
    if (!host) problems.push(`boundary event ${node.id} is not attached to a known activity`);
    else host.boundaryEvents.push(node.id);
  }

  // Compensation: a compensation boundary event on activity A is linked by an
  // *association* (dotted line, not a sequence flow) to the task that undoes A.
  for (const assoc of associations) {
    const boundary = nodes[assoc.sourceRef];
    const handler = nodes[assoc.targetRef];
    if (boundary?.type === 'boundaryEvent' && boundary.eventKind === 'compensate' && handler && boundary.attachedTo) {
      nodes[boundary.attachedTo].compensatedBy = handler.id;
    }
  }

  // Every scope (the process, and each sub-process) needs exactly one plain start event.
  const scopes: (FlowNode | undefined)[] = [undefined, ...Object.values(nodes).filter((n) => n.type === 'subProcess')];
  for (const scope of scopes) {
    const starts = Object.values(nodes).filter((n) => n.type === 'startEvent' && n.parentId === scope?.id);
    const where = scope ? `sub-process "${scope.name ?? scope.id}"` : 'the process';
    if (starts.length !== 1) problems.push(`${where}: expected exactly one start event, found ${starts.length}`);
    else if (scope) scope.startNodeId = starts[0].id;
  }
  problems.push(...validate(nodes, flows));
  if (problems.length) throw new BpmnValidationError(problems);

  const start = Object.values(nodes).find((n) => n.type === 'startEvent' && !n.parentId)!;
  return { key: proc.id, name: proc.name ?? proc.id, version, versionTag: proc.versionTag, startNodeId: start.id, nodes, flows };
}

function parseEventDefinition(el: any, refs: Refs): Partial<FlowNode> {
  if ('timerEventDefinition' in el) {
    return { eventKind: 'timer', timerDuration: text(el.timerEventDefinition?.timeDuration) };
  }
  if ('messageEventDefinition' in el) {
    const ref = el.messageEventDefinition?.messageRef;
    return { eventKind: 'message', message: ref ? refs.messages.get(ref) : undefined };
  }
  if ('errorEventDefinition' in el) {
    const ref = el.errorEventDefinition?.errorRef;
    return { eventKind: 'error', errorCode: ref ? refs.errorCodes.get(ref) ?? ref : undefined };
  }
  if ('compensateEventDefinition' in el) return { eventKind: 'compensate' as EventKind };
  if ('terminateEventDefinition' in el) return { eventKind: 'terminate' as EventKind };
  return { eventKind: 'none' };
}

/** `<bpmn:multiInstanceLoopCharacteristics isSequential="true" mini:collection="${items}" mini:elementVariable="item"/>` */
function parseLoop(el: any): LoopCharacteristics | undefined {
  if (!('multiInstanceLoopCharacteristics' in el)) return undefined;
  const mi = typeof el.multiInstanceLoopCharacteristics === 'object' ? el.multiInstanceLoopCharacteristics : {};
  return {
    sequential: mi.isSequential === 'true',
    collection: mi.collection,
    elementVariable: mi.elementVariable ?? 'item',
    outputCollection: mi.outputCollection,
    outputElement: mi.outputElement,
  };
}

function parseCallActivity(el: any): Partial<FlowNode> {
  return {
    calledElement: el.calledElement,
    binding: (el.calledElementBinding ?? 'latest') as CalledElementBinding,
    calledVersion: el.calledElementVersion ?? el.calledElementVersionTag,
    inputs: list(el.inputs),
    outputs: list(el.outputs),
  };
}

function parseFormFields(spec: string): FormField[] {
  return spec.split(',').map((part) => {
    const [name, type = 'string'] = part.split(':').map((s) => s.trim());
    return { name, type: (['string', 'number', 'boolean'].includes(type) ? type : 'string') as FormField['type'] };
  });
}

/** Activities that can wait, and can therefore have a timer or message boundary event. */
const canWait = (n: FlowNode) => ['userTask', 'receiveTask', 'subProcess', 'callActivity'].includes(n.type) || !!n.loop;

/** The checks a modeler's "linter" would show as red squiggles. */
function validate(nodes: Record<string, FlowNode>, flows: Record<string, SequenceFlow>): string[] {
  const problems: string[] = [];
  const label = (n: FlowNode) => `${n.type} "${n.name ?? n.id}"`;

  for (const n of Object.values(nodes)) {
    const inNormalFlow = !n.isForCompensation;
    if (n.type === 'startEvent' && n.incoming.length) problems.push(`${label(n)} must not have incoming flows`);
    if (n.type === 'startEvent' && n.eventKind !== 'none') problems.push(`${label(n)}: only plain start events are supported (start instances via the API)`);
    if (n.type === 'endEvent' && n.outgoing.length) problems.push(`${label(n)} must not have outgoing flows`);
    if (inNormalFlow && !['startEvent', 'boundaryEvent'].includes(n.type) && !n.incoming.length) {
      problems.push(`${label(n)} is unreachable (no incoming flow)`);
    }
    if (inNormalFlow && n.type !== 'endEvent' && !(n.type === 'boundaryEvent' && n.eventKind === 'compensate') && !n.outgoing.length) {
      problems.push(`${label(n)} is a dead end (no outgoing flow); use an end event`);
    }
    if (n.type === 'serviceTask' && !n.handler) problems.push(`${label(n)} needs a mini:handler attribute`);
    if (n.type === 'intermediateCatchEvent' && !['timer', 'message'].includes(n.eventKind!)) problems.push(`${label(n)}: only timer and message catch events are supported`);
    if (n.type === 'intermediateThrowEvent' && !['compensate', 'none'].includes(n.eventKind!)) problems.push(`${label(n)}: only compensation throw events are supported`);
    if (n.type === 'endEvent' && !['none', 'terminate', 'error'].includes(n.eventKind!)) problems.push(`${label(n)}: only plain, terminate and error end events are supported`);
    if (n.type === 'endEvent' && n.eventKind === 'error' && !n.errorCode) problems.push(`${label(n)} needs an errorRef pointing at a <bpmn:error errorCode="…">`);
    if (n.eventKind === 'timer' && !n.timerDuration) problems.push(`${label(n)} needs a <timeDuration> (e.g. PT10S)`);
    if ((n.eventKind === 'message' || n.type === 'receiveTask') && !n.message) problems.push(`${label(n)} needs a messageRef pointing at a <bpmn:message name="…">`);

    if (n.type === 'boundaryEvent') {
      const host = n.attachedTo ? nodes[n.attachedTo] : undefined;
      if (!['error', 'compensate', 'timer', 'message'].includes(n.eventKind!)) {
        problems.push(`${label(n)}: only error, compensation, timer and message boundary events are supported`);
      } else if (host && ['timer', 'message'].includes(n.eventKind!) && !canWait(host)) {
        problems.push(`${label(n)}: a ${n.eventKind} boundary needs an activity that waits (user/receive task, sub-process, call activity or multi-instance), not ${label(host)}`);
      }
      if (n.eventKind === 'error' && n.interrupting === false) problems.push(`${label(n)}: error boundary events are always interrupting`);
    }
    if (n.loop && !ACTIVITY_TYPES.includes(n.type)) problems.push(`${label(n)}: only activities can be multi-instance`);
    if (n.loop && !n.loop.collection) problems.push(`${label(n)}: multi-instance needs mini:collection, e.g. \${containerList}`);
    if (n.loop?.outputElement && !n.loop.outputCollection) problems.push(`${label(n)}: mini:outputElement needs mini:outputCollection`);

    if (n.type === 'callActivity') {
      if (!n.calledElement) problems.push(`${label(n)} needs calledElement="<process key>"`);
      if (!['latest', 'version', 'versionTag'].includes(n.binding!)) problems.push(`${label(n)}: mini:calledElementBinding must be latest, version or versionTag`);
      if (n.binding !== 'latest' && !n.calledVersion) {
        problems.push(`${label(n)}: binding "${n.binding}" needs mini:calledElement${n.binding === 'version' ? 'Version' : 'VersionTag'}`);
      }
    }
    if (n.type === 'exclusiveGateway' && n.outgoing.length > 1) {
      const unguarded = n.outgoing.filter((id) => !flows[id].condition && id !== n.defaultFlow);
      if (unguarded.length) problems.push(`${label(n)}: flows ${unguarded.join(', ')} need a condition or must be the default flow`);
    }
    if (n.type === 'eventBasedGateway') {
      if (n.outgoing.length < 2) problems.push(`${label(n)} needs at least two outgoing flows (one per event it races)`);
      for (const id of n.outgoing) {
        const target = nodes[flows[id].targetRef];
        if (flows[id].condition) problems.push(`${label(n)}: flow ${id} must not have a condition; the first event to happen wins`);
        if (target && !(target.type === 'intermediateCatchEvent' && ['timer', 'message'].includes(target.eventKind!))) {
          problems.push(`${label(n)}: flow ${id} must lead to a timer or message catch event, not ${label(target)}`);
        }
      }
    }
  }
  return problems;
}
