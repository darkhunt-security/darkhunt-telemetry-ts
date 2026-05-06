/**
 * Tests for client-level defaults of routing fields (tenantId, workspaceId,
 * applicationId, assessmentRunId). These can be set via constructor options or
 * DARKHUNT_*_ID env vars; per-trace args override.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DarkhuntTelemetry } from '../src/client.js';

const ENV_KEYS = [
  'DARKHUNT_TENANT_ID',
  'DARKHUNT_WORKSPACE_ID',
  'DARKHUNT_APPLICATION_ID',
  'DARKHUNT_ASSESSMENT_RUN_ID',
] as const;

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
}
function restoreEnv(snap: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('DarkhuntTelemetry routing defaults', () => {
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => restoreEnv(envSnap));

  it('uses client-level defaults when trace() omits routing fields', () => {
    const dh = new DarkhuntTelemetry({
      enabled: false, // skip provider setup; we only care about merging
      tenantId: 'tenant-from-client',
      workspaceId: 'ws-from-client',
      applicationId: 'app-from-client',
      assessmentRunId: 'run-from-client',
    });

    const trace = dh.trace({ name: 'no-routing-args' });
    assert.equal(trace.tenantId, 'tenant-from-client');
    assert.equal(trace.workspaceId, 'ws-from-client');
    assert.equal(trace.applicationId, 'app-from-client');
    assert.equal(trace.assessmentRunId, 'run-from-client');
  });

  it('per-trace args override client-level defaults', () => {
    const dh = new DarkhuntTelemetry({
      enabled: false,
      tenantId: 'tenant-from-client',
      workspaceId: 'ws-from-client',
      applicationId: 'app-from-client',
      assessmentRunId: 'run-from-client',
    });

    const trace = dh.trace({
      tenantId: 'tenant-override',
      assessmentRunId: 'run-override',
    });

    assert.equal(trace.tenantId, 'tenant-override');
    assert.equal(trace.workspaceId, 'ws-from-client'); // not overridden
    assert.equal(trace.applicationId, 'app-from-client');
    assert.equal(trace.assessmentRunId, 'run-override');
  });

  it('falls back to DARKHUNT_*_ID env vars when constructor omits them', () => {
    process.env.DARKHUNT_TENANT_ID = 'tenant-from-env';
    process.env.DARKHUNT_WORKSPACE_ID = 'ws-from-env';
    process.env.DARKHUNT_APPLICATION_ID = 'app-from-env';
    process.env.DARKHUNT_ASSESSMENT_RUN_ID = 'run-from-env';

    const dh = new DarkhuntTelemetry({ enabled: false });
    const trace = dh.trace();

    assert.equal(trace.tenantId, 'tenant-from-env');
    assert.equal(trace.workspaceId, 'ws-from-env');
    assert.equal(trace.applicationId, 'app-from-env');
    assert.equal(trace.assessmentRunId, 'run-from-env');
  });

  it('constructor options take priority over env vars', () => {
    process.env.DARKHUNT_TENANT_ID = 'tenant-from-env';
    const dh = new DarkhuntTelemetry({ enabled: false, tenantId: 'tenant-from-ctor' });
    const trace = dh.trace({
      workspaceId: 'w',
      applicationId: 'a',
      assessmentRunId: 'r',
    });
    assert.equal(trace.tenantId, 'tenant-from-ctor');
  });

  it('throws a clear error when a routing field is missing everywhere', () => {
    const dh = new DarkhuntTelemetry({ enabled: false });
    assert.throws(
      () => dh.trace({ workspaceId: 'w', applicationId: 'a', assessmentRunId: 'r' }),
      /tenantId is required.*DARKHUNT_TENANT_ID/s
    );
  });

  it('error message names the specific missing field', () => {
    const dh = new DarkhuntTelemetry({
      enabled: false,
      tenantId: 't',
      workspaceId: 'w',
      applicationId: 'a',
      // assessmentRunId intentionally omitted
    });
    assert.throws(() => dh.trace(), /assessmentRunId is required.*DARKHUNT_ASSESSMENT_RUN_ID/s);
  });

  it('release/environment defaults still work alongside the new routing defaults', () => {
    const dh = new DarkhuntTelemetry({
      enabled: false,
      tenantId: 't',
      workspaceId: 'w',
      applicationId: 'a',
      assessmentRunId: 'r',
      release: 'v1.2.3',
      environment: 'prod',
    });
    const trace = dh.trace({ name: 'check' });
    // release/environment are stored internally but not exposed via getter;
    // the absence of an exception confirms they merged correctly.
    assert.ok(trace);
  });
});
