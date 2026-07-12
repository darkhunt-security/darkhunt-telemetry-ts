// Handoff-over-Temporal-Header — shared constants + a workflow-safe helper.
//
// A Darkhunt handoff token an agent nests under travels in a TEMPORAL HEADER
// (out-of-band metadata), NOT in the business args. A coordinator authors a
// per-edge choice by attaching it as hidden metadata on a child's input via
// {@link childArgs}; the workflow OUTBOUND interceptor relocates that to the
// header and strips it before the child sees it. Every other hop is
// context-propagated (a workflow forwards its own incoming header to its
// children + activities).
//
// This module is workflow-sandbox-safe: pure JS + constants, no imports. It is
// imported by the workflow interceptors, the activity interceptor, and any
// workflow/gateway code that needs the key.

/** Temporal Header key carrying the handoff token array (a Payload of `string[]`). */
export const HANDOFF_HEADER = 'x-darkhunt-handoff';

/** Reserved input key a coordinator uses to hand a per-edge override to the
 *  outbound interceptor; stripped from the child's args before the wire. */
export const HANDOFF_META = '__dhHandoff';

/**
 * Build the single-element args tuple `executeChild` / `startChild` want, attaching
 * the chosen upstream handoff token(s) as hidden metadata. The workflow outbound
 * interceptor moves them into the Temporal Header and removes this key, so the child
 * workflow receives ONLY its business input. With no `handoffFrom`, the child inherits
 * the parent workflow's own incoming header (plain propagation) — return the input untouched.
 */
export function childArgs<T extends object>(input: T, handoffFrom?: string[]): [T] {
  if (!handoffFrom || handoffFrom.length === 0) return [input];
  return [{ ...input, [HANDOFF_META]: handoffFrom } as T];
}
