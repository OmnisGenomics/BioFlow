import type { Connector, ConnectorContext, ConnectorResult } from "./connector.js";

export class ElnSimConnector implements Connector {
  public readonly id = "eln_sim";

  async invoke(ctx: ConnectorContext): Promise<ConnectorResult> {
    const payload = {
      connectorId: this.id,
      operation: ctx.operation,
      received: ctx.inputs.map((a) => ({ name: a.name, sha256: a.sha256 }))
    };
    const artifact = await ctx.store.putJson({
      runId: ctx.runId,
      name: `connector.${this.id}.ack.json`,
      value: payload,
      kind: "ack"
    });
    return { outputs: [artifact], costUSD: 0.005, notes: "Simulated connector invocation" };
  }
}
