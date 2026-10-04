// bpmn-moddle 10 ships ESM with its types behind an `exports` subpath that `moduleResolution: node` can't see.
// The engine only needs fromXML, so a minimal declaration is enough.
declare module 'bpmn-moddle' {
  export class BpmnModdle {
    constructor(packages?: Record<string, unknown>);
    fromXML(xml: string): Promise<{ rootElement: any; warnings: { message: string }[] }>;
  }
}
