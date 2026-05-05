export const ATTR = {
  OBSERVATION_TYPE: 'darkhunt.observation.type',
  OBSERVATION_INPUT: 'darkhunt.observation.input',
  OBSERVATION_OUTPUT: 'darkhunt.observation.output',
  OBSERVATION_LEVEL: 'darkhunt.observation.level',
  STATUS_MESSAGE: 'darkhunt.status_message',
  VERSION: 'darkhunt.version',
  /**
   * Prefix for freeform metadata. Each entry is emitted as its own OTLP
   * attribute keyed `darkhunt.observation.metadata.<userKey>`, matching the
   * `metadataPrefix` declared in trace-hub's `mappings/darkhunt.yaml`. The
   * consumer iterates attributes by prefix and strips it back off, so each
   * entry must live in its own attribute — a single JSON-blob attribute
   * gets dropped on ingest.
   */
  METADATA_PREFIX: 'darkhunt.observation.metadata.',
  TENANT_ID: 'darkhunt.tenant_id',
  WORKSPACE_ID: 'darkhunt.workspace_id',
  APPLICATION_ID: 'darkhunt.application_id',
  ASSESSMENT_RUN_ID: 'darkhunt.assessment_run_id',
  SESSION_ID: 'darkhunt.session.id',
  USER_ID: 'darkhunt.user.id',
  USER_EMAIL: 'darkhunt.user.email',
  TRACE_NAME: 'darkhunt.trace.name',
  TRACE_TAGS: 'darkhunt.trace.tags',
  RELEASE: 'darkhunt.release',
  ENVIRONMENT: 'darkhunt.environment',
  MODEL_NAME: 'darkhunt.observation.model.name',
  MODEL_PARAMETERS: 'darkhunt.observation.model.parameters',
  USAGE_DETAILS: 'darkhunt.observation.usage_details',
  COST_DETAILS: 'darkhunt.observation.cost_details',
  COMPLETION_START_TIME: 'darkhunt.observation.completion_start_time',
  PROMPT_NAME: 'darkhunt.observation.prompt.name',
  PROMPT_VERSION: 'darkhunt.observation.prompt.version',
} as const;

export const GEN_AI = {
  REQUEST_MODEL: 'gen_ai.request.model',
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  USAGE_CACHE_READ_INPUT_TOKENS: 'gen_ai.usage.cache_read.input_tokens',
  USAGE_CACHE_CREATION_INPUT_TOKENS: 'gen_ai.usage.cache_creation.input_tokens',
  USAGE_COST: 'gen_ai.usage.cost',
  /** OTel GenAI semantic convention for structured chat input. JSON-encoded array of {role, content}. */
  INPUT_MESSAGES: 'gen_ai.input.messages',
  /** OTel GenAI semantic convention for structured chat output. JSON-encoded array of {role, content}. */
  OUTPUT_MESSAGES: 'gen_ai.output.messages',
  /** OTel GenAI semantic convention for the system prompt sent to the model. */
  SYSTEM_INSTRUCTIONS: 'gen_ai.system_instructions',
} as const;
