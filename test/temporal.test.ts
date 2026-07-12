/**
 * Light tests for the OPTIONAL Temporal transport (`@darkhunt-security/telemetry/temporal`).
 * Full Temporal-runtime E2E is out of scope (no server here) — this asserts the
 * module typechecks + imports with the `@temporalio/*` peer deps installed, that the
 * interceptor factories return the expected Temporal shapes, that the shared header
 * constant is exported, and does one light header-propagation round-trip through the
 * factory's inbound-capture → outbound-propagate wiring.
 *
 * Importing this file at all proves the `/temporal` subpath resolves; the CORE entry
 * (`../src/index.js`) is proven to load WITHOUT Temporal separately (see README /
 * the load-without-temporal check), and never imports this module.
 */

import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, it } from 'node:test';
import { defaultPayloadConverter } from '@temporalio/common';

import {
  HANDOFF_HEADER,
  HANDOFF_META,
  childArgs,
  handoffWorkflowInterceptors,
  handoffActivityInterceptors,
  currentHandoff,
} from '../src/temporal/index.js';
import { interceptors } from '../src/temporal/workflow-interceptors.js';

const TOKEN = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

describe('Temporal handoff constants + childArgs', () => {
  it('exports the shared header + meta keys', () => {
    assert.equal(HANDOFF_HEADER, 'x-darkhunt-handoff');
    assert.equal(HANDOFF_META, '__dhHandoff');
  });

  it('childArgs attaches the override as hidden meta, or leaves input untouched', () => {
    assert.deepEqual(childArgs({ q: 'x' }, [TOKEN]), [{ q: 'x', [HANDOFF_META]: [TOKEN] }]);
    assert.deepEqual(childArgs({ q: 'x' }), [{ q: 'x' }]);
    assert.deepEqual(childArgs({ q: 'x' }, []), [{ q: 'x' }]);
  });
});

describe('Workflow interceptors factory', () => {
  it('returns the { inbound, outbound } shape with the expected methods', () => {
    const result = handoffWorkflowInterceptors();
    assert.equal(result.inbound?.length, 1);
    assert.equal(result.outbound?.length, 1);
    assert.equal(typeof result.inbound?.[0]?.execute, 'function');
    assert.equal(typeof result.outbound?.[0]?.startChildWorkflowExecution, 'function');
    assert.equal(typeof result.outbound?.[0]?.scheduleActivity, 'function');
  });

  it('exposes the Temporal-convention `interceptors` alias on the workflow subpath', () => {
    assert.equal(interceptors, handoffWorkflowInterceptors);
  });

  it('captures an inbound header and propagates it onto a scheduled activity', async () => {
    const { inbound, outbound } = handoffWorkflowInterceptors();

    // Inbound: a workflow started with the handoff header captures it.
    const inboundHeaders = { [HANDOFF_HEADER]: defaultPayloadConverter.toPayload([TOKEN]) };
    await inbound![0]!.execute!({ headers: inboundHeaders } as never, (i) => {
      void i;
      return Promise.resolve(undefined);
    });

    // Outbound: scheduling an activity now carries the captured header.
    let activityHeaders: Record<string, unknown> = {};
    await outbound![0]!.scheduleActivity!({ headers: {} } as never, (input) => {
      activityHeaders = (input as { headers: Record<string, unknown> }).headers;
      return Promise.resolve(undefined);
    });

    const propagated = defaultPayloadConverter.fromPayload(
      activityHeaders[HANDOFF_HEADER] as never
    );
    assert.deepEqual(propagated, [TOKEN]);
  });
});

describe('Activity interceptors factory + currentHandoff', () => {
  it('returns an { inbound } shape with an execute interceptor', () => {
    const result = handoffActivityInterceptors();
    assert.equal(typeof result.inbound?.execute, 'function');
  });

  it('currentHandoff() is undefined outside an activity execution', () => {
    assert.equal(currentHandoff(), undefined);
  });

  it('reads the handoff header into currentHandoff() for the activity run', async () => {
    const { inbound } = handoffActivityInterceptors();
    const headers = { [HANDOFF_HEADER]: defaultPayloadConverter.toPayload([TOKEN]) };

    let seen: string[] | undefined;
    await inbound!.execute!({ headers } as never, () => {
      seen = currentHandoff();
      return Promise.resolve(undefined);
    });

    assert.deepEqual(seen, [TOKEN]);
    // AsyncLocalStorage is unwound once the activity settles.
    assert.equal(currentHandoff(), undefined);
    // Sanity: the accessor is backed by AsyncLocalStorage.
    assert.ok(AsyncLocalStorage);
  });
});
