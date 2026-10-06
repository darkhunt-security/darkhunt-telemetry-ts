/**
 * DarkhuntPolicy, agtTool, runGoverned and checkToolPoint against AGT's real ACS runtime
 * (`agent-control-specification`, a dev dependency) and a stub /verify.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { AgentControl } from 'agent-control-specification';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import { agtTool, checkToolPoint, DarkhuntPolicy, runGoverned } from '../src/agt.js';
import { ATTR } from '../src/attributes.js';
import { configureGuard, resetGuardConfig, type GuardConfigOptions } from '../src/guard/index.js';
import { registerOtelContextGlobals } from '../src/otel-globals.js';
import { Trace } from '../src/trace.js';
import { VerifyStub } from './support/verify-stub.js';

const MANIFEST = `agent_control_specification_version: 0.3.1-beta
metadata: {name: darkhunt-test}
policies:
  darkhunt: {type: custom, adapter: darkhunt}
intervention_points:
  pre_tool_call:  {policy: {id: darkhunt}, policy_target: $.tool_call.args}
  post_tool_call: {policy: {id: darkhunt}, policy_target: $.tool_result}
annotators: {}
`;

describe('AGT plug-in (real ACS runtime)', () => {
  let stub: VerifyStub;
  let control: AgentControl;
  let exporter: InMemorySpanExporter;
  let tracer: ReturnType<BasicTracerProvider['getTracer']>;
  let calls: string[];

  const configure = (options: GuardConfigOptions = {}) =>
    configureGuard({ url: stub.url, apiKey: 'dh-test', mode: 'enforce', fail: 'open', ...options });
  const newTrace = (sessionId = 's-1') =>
    new Trace(tracer, {
      name: 'agent',
      tenantId: 't1',
      workspaceId: 'ws1',
      applicationId: 'app1',
      sessionId,
      agent: 'advisor-copilot',
    });
  const holdings = () =>
    agtTool(control, function get_holdings(input: { householdId: string }) {
      calls.push(input.householdId);
      return { household: input.householdId, positions: 3 };
    });

  before(() => {
    registerOtelContextGlobals();
    const dir = mkdtempSync(join(tmpdir(), 'agt-'));
    writeFileSync(join(dir, 'agt.yaml'), MANIFEST);
    control = AgentControl.fromPath(join(dir, 'agt.yaml'), undefined, new DarkhuntPolicy());
  });
  beforeEach(async () => {
    stub = await new VerifyStub().start();
    exporter = new InMemorySpanExporter();
    tracer = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    }).getTracer('t');
    calls = [];
  });
  afterEach(async () => {
    await stub.stop();
    resetGuardConfig();
  });
  after(() => resetGuardConfig());

  it('checks an allowed call before and after, with the run’s session and agent', async () => {
    configure();
    const out = await newTrace().activate(() => holdings()({ householdId: 'HH-1' }));
    assert.deepEqual(out, { household: 'HH-1', positions: 3 });
    assert.deepEqual(calls, ['HH-1']);
    assert.deepEqual(stub.stages(), ['TOOL_CALL:get_holdings', 'TOOL_RESULT:get_holdings']);
    const [pre, post] = stub.requests.map((r) => r.body);
    assert.equal(pre!.sessionId, 's-1');
    assert.equal(pre!.source, 'advisor-copilot');
    assert.deepEqual(pre!.tool.arguments, { householdId: 'HH-1' });
    assert.deepEqual(post!.tool.result, { household: 'HH-1', positions: 3 });
    assert.equal(pre!.tool.callId, post!.tool.callId);
  });

  it('a deny before the call means the tool never runs, and is recorded under the run', async () => {
    configure();
    stub.deny('TOOL_CALL', 'get_holdings', 'No custody reads');
    const trace = newTrace();
    const out = await trace.activate(() => holdings()({ householdId: 'HH-1' }));
    trace.end();
    assert.deepEqual(calls, []);
    assert.equal(out, 'Blocked by Darkhunt: No custody reads. The get_holdings tool was not run.');
    // The policy runs where the caller's async context is gone; the run is handed over.
    const check = exporter.getFinishedSpans().find((s) => s.name === 'darkhunt.guard.tool_call');
    const root = exporter.getFinishedSpans().find((s) => s.name === 'agent');
    assert.equal(check?.parentSpanContext?.spanId, root?.spanContext().spanId);
    assert.equal(check?.attributes[ATTR.METADATA_PREFIX + 'guard.decision'], 'DENY');
  });

  it('a deny after the call withholds the output', async () => {
    configure();
    stub.deny('TOOL_RESULT', 'get_holdings', 'Injection in tool output');
    const out = await newTrace().activate(() => holdings()({ householdId: 'HH-1' }));
    assert.deepEqual(calls, ['HH-1']);
    assert.match(String(out), /^Withheld by Darkhunt: Injection in tool output\./);
  });

  it('shadow mode lets a deny through as a warning', async () => {
    configure({ mode: 'shadow' });
    stub.deny('TOOL_CALL', 'get_holdings');
    const out = await newTrace().activate(() => holdings()({ householdId: 'HH-1' }));
    assert.deepEqual(out, { household: 'HH-1', positions: 3 });
  });

  it('an unreachable Darkhunt follows the fail mode', async () => {
    for (const [fail, runs] of [
      ['open', true],
      ['closed', false],
    ] as const) {
      calls = [];
      configureGuard({
        url: 'http://127.0.0.1:9',
        apiKey: 'k',
        mode: 'enforce',
        fail,
        callTimeoutMs: 300,
      });
      const out = await newTrace().activate(() => holdings()({ householdId: 'HH-1' }));
      assert.equal(calls.length === 1, runs, `fail=${fail}`);
      if (!runs) assert.match(String(out), /^Blocked by Darkhunt/);
    }
  });

  it('runGoverned dispatches a call by name; no control just runs it', async () => {
    configure();
    stub.deny('TOOL_CALL', 'send_wire');
    const ran: number[] = [];
    const out = await newTrace('s-loop').activate(() =>
      runGoverned(control, 'send_wire', { amount: 48000 }, () => ran.push(1))
    );
    assert.match(String(out), /^Blocked by Darkhunt/);
    assert.deepEqual(ran, []);
    assert.equal(stub.requests[0]!.body.sessionId, 's-loop');
    assert.deepEqual(stub.requests[0]!.body.tool.arguments, { amount: 48000 });

    stub.requests.length = 0;
    assert.equal(await runGoverned(null, 'send_wire', {}, () => 'sent'), 'sent');
    assert.equal(stub.requests.length, 0);
  });

  it('hook-style checks ask one point without running anything', async () => {
    configure();
    stub.deny('TOOL_CALL', 'Bash', 'No shell');
    stub.deny('TOOL_RESULT', 'WebFetch', 'Injection in tool output');
    const [preBash, preRead, postFetch] = await newTrace('s-hook').activate(async () => [
      await checkToolPoint(control, 'pre_tool_call', 'Bash', { command: 'ls' }),
      await checkToolPoint(control, 'pre_tool_call', 'Read', { file_path: 'a' }),
      await checkToolPoint(
        control,
        'post_tool_call',
        'WebFetch',
        { url: 'u' },
        { result: 'IGNORE ALL' }
      ),
    ]);
    assert.equal(preBash, 'Blocked by Darkhunt: No shell. The Bash tool was not run.');
    assert.equal(preRead, undefined);
    assert.match(String(postFetch), /^Withheld by Darkhunt: Injection in tool output\./);
    assert.equal(stub.requests.at(-1)!.body.tool.result, 'IGNORE ALL');
  });

  it('points without a /verify stage are allowed unchecked', async () => {
    configure();
    const verdict = await new DarkhuntPolicy().evaluate({
      input: { intervention_point: 'pre_model_call' },
    });
    assert.deepEqual(verdict, { decision: 'allow' });
    assert.equal(stub.requests.length, 0);
  });
});
