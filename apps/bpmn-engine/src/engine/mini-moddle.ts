/**
 * The `mini:` extension namespace, as a moddle schema.
 *
 * BPMN is extensible: every vendor adds its own attributes in its own XML
 * namespace (Camunda: `zeebe:taskDefinition`, Flowable: `flowable:class`).
 * Registering the schema with bpmn-moddle turns `mini:handler="ocean.book"`
 * into a plain `handler` property on the parsed element, which is how the
 * engine (and bpmn-elements behind it) gets to read it.
 *
 * public/index.html registers the same schema with bpmn-js, so the modeler
 * keeps these attributes when you edit and export a diagram.
 */
export const MINI_MODDLE = {
  name: 'Mini',
  uri: 'https://example.com/mini-bpmn',
  prefix: 'mini',
  xml: { tagAlias: 'lowerCase' },
  associations: [],
  types: [
    { name: 'HandlerTask', extends: ['bpmn:ServiceTask'], properties: [{ name: 'handler', isAttr: true, type: 'String' }] },
    { name: 'FormTask', extends: ['bpmn:UserTask'], properties: [{ name: 'formFields', isAttr: true, type: 'String' }] },
    { name: 'VersionedProcess', extends: ['bpmn:Process'], properties: [{ name: 'versionTag', isAttr: true, type: 'String' }] },
    { name: 'CorrelatedMessage', extends: ['bpmn:Message'], properties: [{ name: 'correlationKey', isAttr: true, type: 'String' }] },
    {
      name: 'CalledProcess',
      extends: ['bpmn:CallActivity'],
      properties: ['calledElementBinding', 'calledElementVersion', 'calledElementVersionTag', 'inputs', 'outputs'].map((name) => ({ name, isAttr: true, type: 'String' })),
    },
    {
      name: 'Loop',
      extends: ['bpmn:MultiInstanceLoopCharacteristics'],
      properties: ['collection', 'elementVariable', 'outputCollection', 'outputElement'].map((name) => ({ name, isAttr: true, type: 'String' })),
    },
  ],
};
