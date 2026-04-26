export type ObservationType =
  | 'span'
  | 'tool'
  | 'agent'
  | 'generation'
  | 'event'
  | 'chain'
  | 'retriever'
  | 'evaluator'
  | 'embedding'
  | 'guardrail';

export type ObservationLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  [key: string]: number | undefined;
}

export interface Cost {
  total?: number;
  [key: string]: number | undefined;
}

export type Metadata = Record<string, unknown>;
