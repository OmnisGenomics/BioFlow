import type { Connector } from "./connector.js";
import { ElnSimConnector } from "./eln-sim.js";
import { CleanCsvConnector } from "./clean-csv.js";

export type ConnectorRegistry = Readonly<Record<string, Connector>>;

export function createDefaultConnectors(): ConnectorRegistry {
  const elnSim = new ElnSimConnector();
  const cleanCsv = new CleanCsvConnector();
  return {
    [elnSim.id]: elnSim,
    [cleanCsv.id]: cleanCsv
  };
}
