/**
 * Conditions on sequence flows, e.g. `${quote.amount > 10000}`.
 *
 * Real engines use a dedicated, sandboxed expression language: JUEL in
 * Camunda 7, FEEL (from the DMN standard) in Camunda 8. Here the expression is
 * plain JavaScript with the process variables in scope. That's fine for
 * learning but NOT safe for untrusted diagrams: whoever deploys a diagram can
 * run code on the server.
 */
export function evaluate(expression: string, variables: Record<string, unknown>): unknown {
  const body = expression.trim().replace(/^\$\{([\s\S]*)\}$/, '$1');
  const names = Object.keys(variables).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k));
  const fn = new Function(...names, `return (${body});`);
  return fn(...names.map((k) => variables[k]));
}

/** ISO-8601 duration → milliseconds. Supports PnDTnHnMnS, e.g. PT10S, PT1M30S, P1D. */
export function durationMs(iso: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso.trim());
  if (!m) throw new Error(`unsupported timer duration "${iso}" (use e.g. PT10S)`);
  const [, d = 0, h = 0, min = 0, s = 0] = m;
  return ((+d * 24 + +h) * 60 + +min) * 60_000 + +s * 1000;
}
