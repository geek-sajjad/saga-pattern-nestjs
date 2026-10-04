/**
 * Expressions such as `${quote.amount > 10000}` in conditions, `${containerList}`
 * as a loop collection, or `${shipmentRef}` as a correlation key.
 *
 * Real engines use a dedicated, sandboxed expression language: JUEL in
 * Camunda 7, FEEL (from the DMN standard) in Camunda 8. bpmn-engine's own
 * default only resolves paths such as `${environment.variables.quote.amount}`,
 * with no operators. Here the expression is plain JavaScript with the process
 * variables in scope. That's fine for learning but NOT safe for untrusted
 * diagrams: whoever deploys a diagram can run code on the server.
 */
export function evaluate(expression: string, variables: Record<string, unknown>): unknown {
  const body = expression.trim().replace(/^\$\{([\s\S]*)\}$/, '$1');
  const names = Object.keys(variables).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k));
  const fn = new Function(...names, `return (${body});`);
  return fn(...names.map((k) => variables[k]));
}

const WHOLE = /^\s*\$\{[\s\S]*\}\s*$/;

/**
 * The expressions handler bpmn-engine calls for every attribute that may hold
 * an expression (conditions, loop collections, timer values, called element…).
 * `scope` decides which variables an expression sees at that point.
 */
export function libraryExpressions(scope: (context: any) => Record<string, unknown>) {
  return {
    resolveExpression(expression: unknown, context: any = {}) {
      if (typeof expression !== 'string' || !expression.includes('${')) return expression;
      const variables = scope(context);
      if (WHOLE.test(expression)) return evaluate(expression, variables);
      // "Shipment ${shipmentRef} arrived": a string with expressions inside.
      return expression.replace(/\$\{([^}]*)\}/g, (_, body) => String(evaluate(body, variables)));
    },
    isExpression: (text: unknown) => typeof text === 'string' && WHOLE.test(text),
    hasExpression: (text: unknown) => typeof text === 'string' && text.includes('${'),
  };
}
