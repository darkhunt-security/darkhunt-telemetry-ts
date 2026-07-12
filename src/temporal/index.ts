// Optional Temporal transport for Darkhunt handoff propagation, behind its own
// subpath export (`@darkhunt-security/telemetry/temporal`) and OPTIONAL peer
// dependencies on `@temporalio/*`. The core package (`@darkhunt-security/telemetry`)
// never imports this module, so it loads with zero Temporal packages installed.
//
// This barrel is for WORKER-side setup code, where importing both the workflow and
// activity pieces is fine. WORKFLOW-sandbox code must instead import the
// workflow-only subpath `@darkhunt-security/telemetry/temporal/workflow` (it pulls
// only `@temporalio/workflow`), which is what `workflowInterceptorModules` points at.

export { HANDOFF_HEADER, HANDOFF_META, childArgs } from './handoff-header.js';
export { handoffWorkflowInterceptors } from './workflow-interceptors.js';
export { currentHandoff, handoffActivityInterceptors } from './activity-interceptors.js';
