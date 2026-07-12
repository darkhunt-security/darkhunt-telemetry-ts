// Temporal WORKFLOW interceptors that carry the Darkhunt handoff token in a
// TEMPORAL HEADER (context propagation, with a per-edge override) — so the
// business args stay pure.
//
//   • inbound.execute              — capture the incoming handoff header for this run.
//   • outbound.startChildWorkflow  — if the caller attached a per-edge override
//                                    (HANDOFF_META in the child's input, via
//                                    {@link childArgs}), relocate it to the header +
//                                    strip it; else propagate this workflow's own
//                                    incoming header.
//   • outbound.scheduleActivity    — propagate this workflow's incoming header to the
//                                    activity (so the activity nests under the same token).
//
// WORKFLOW-SANDBOX-SAFE: the only runtime import is `@temporalio/workflow` (an
// OPTIONAL peer dependency). Point Temporal's `workflowInterceptorModules` at
// `@darkhunt-security/telemetry/temporal/workflow` — this module exports
// `interceptors` (the name Temporal looks up), so it can be used as-is when the
// Darkhunt handoff is your only workflow interceptor.

import { defaultPayloadConverter } from '@temporalio/workflow';
import type { Payload } from '@temporalio/workflow';
import type {
  ActivityInput,
  Next,
  StartChildWorkflowExecutionInput,
  WorkflowExecuteInput,
  WorkflowInboundCallsInterceptor,
  WorkflowInterceptors,
  WorkflowInterceptorsFactory,
  WorkflowOutboundCallsInterceptor,
} from '@temporalio/workflow';
import { HANDOFF_HEADER, HANDOFF_META } from './handoff-header.js';

const decode = (p: Payload | undefined): string[] | undefined => {
  if (!p) return undefined;
  try {
    const v = defaultPayloadConverter.fromPayload(p);
    return Array.isArray(v) ? (v as string[]) : undefined;
  } catch {
    return undefined;
  }
};

const encode = (tokens: string[]): Payload => defaultPayloadConverter.toPayload(tokens) as Payload;

/**
 * The reusable Darkhunt handoff {@link WorkflowInterceptorsFactory}. Temporal runs
 * this factory once per workflow execution, so `shared` is per-execution state
 * linking the inbound capture to the outbound propagation.
 *
 * Compose it with your own workflow interceptors, or export it directly as
 * `interceptors` (this module already does) and point `workflowInterceptorModules`
 * at this subpath when it's the only one you need.
 */
export const handoffWorkflowInterceptors: WorkflowInterceptorsFactory =
  (): WorkflowInterceptors => {
    const shared: { incoming?: string[] } = {};

    const inbound: WorkflowInboundCallsInterceptor = {
      execute(
        input: WorkflowExecuteInput,
        next: Next<WorkflowInboundCallsInterceptor, 'execute'>
      ): Promise<unknown> {
        const incoming = decode(input.headers[HANDOFF_HEADER]);
        if (incoming?.length) shared.incoming = incoming;
        return next(input);
      },
    };

    const outbound: WorkflowOutboundCallsInterceptor = {
      startChildWorkflowExecution(
        input: StartChildWorkflowExecutionInput,
        next: Next<WorkflowOutboundCallsInterceptor, 'startChildWorkflowExecution'>
      ): Promise<[Promise<string>, Promise<unknown>]> {
        const args = input.options.args ?? [];
        const first = args[0] as Record<string, unknown> | undefined;
        const override = first?.[HANDOFF_META] as string[] | undefined;
        if (override?.length) {
          // Per-edge override: relocate to the header and strip it from the child's args.
          const { [HANDOFF_META]: _drop, ...clean } = first as Record<string, unknown>;
          return next({
            ...input,
            options: { ...input.options, args: [clean, ...args.slice(1)] },
            headers: { ...input.headers, [HANDOFF_HEADER]: encode(override) },
          });
        }
        if (shared.incoming?.length) {
          return next({
            ...input,
            headers: { ...input.headers, [HANDOFF_HEADER]: encode(shared.incoming) },
          });
        }
        return next(input);
      },

      scheduleActivity(
        input: ActivityInput,
        next: Next<WorkflowOutboundCallsInterceptor, 'scheduleActivity'>
      ): Promise<unknown> {
        if (shared.incoming?.length) {
          return next({
            ...input,
            headers: { ...input.headers, [HANDOFF_HEADER]: encode(shared.incoming) },
          });
        }
        return next(input);
      },
    };

    return { inbound: [inbound], outbound: [outbound] };
  };

/**
 * Temporal looks up the named export `interceptors` on each module listed in
 * `workflowInterceptorModules`. Aliasing the factory to that name lets an app
 * register this subpath directly when the Darkhunt handoff is its only workflow
 * interceptor. Apps that also have their own interceptors should instead import
 * {@link handoffWorkflowInterceptors} and compose it in their own module.
 */
export const interceptors: WorkflowInterceptorsFactory = handoffWorkflowInterceptors;

// Re-export the sandbox-safe handoff helpers so workflow code (which may ONLY import the
// `/temporal/workflow` subpath — the worker-side barrel pulls in node:async_hooks and breaks
// the deterministic bundler) can author per-edge overrides with `childArgs` and reference the
// header/meta keys, without a local copy. `handoff-header.ts` is pure JS + constants.
export { childArgs, HANDOFF_HEADER, HANDOFF_META } from './handoff-header.js';
