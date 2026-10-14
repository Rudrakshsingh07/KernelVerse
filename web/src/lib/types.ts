export interface Step {
  tick: number;
  state: Record<string, unknown>;
  highlight: string[];
  explanation: string;
}

export interface SimulationResult {
  steps: Step[];
  metrics: Record<string, unknown>;
  warnings: string[];
}
