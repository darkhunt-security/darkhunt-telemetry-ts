/**
 * guard() against a stub /verify server: what reaches the server, what the caller
 * gets back, and what is recorded on the trace.
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';

import { ATTR } from '../src/attributes.js';
import { currentObservation } from '../src/current.js';
import {
  configureGuard,
  DarkhuntBlockedError,
  guard,
  resetGuardConfig,
  type GuardConfigOptions,
  type Verdict,
} from '../src/guard/index.js';
import { registerOtelContextGlobals } from '../src/otel-globals.js';
import { Trace } from '../src/trace.js';
import { VerifyStub } from './support/verify-stub.js';

const META = ATTR.METADATA_PREFIX;

function setup() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { exporter, tracer: provider.getTracer('test') };
}

function byName(exporter: InMemorySpanExporter, name: string): ReadableSpan[] {
  return exporter.getFinishedSpans().filter((s) => s.name === name);
}

describe('guard', () => {
  let stub: VerifyStub;
  let mem: ReturnType<typeof setup>;
  let calls: string[];

  const configure = (options: GuardConfigOptions = {}) =>
    configureGuard({ url: stub.url, apiKey: 'dh-test', mode: 'enforce', fail: 'open', ...options });
  const newTrace = (sessionId = 's-1') =>
    new Trace(mem.tracer, {
      name: 'agent',
      tenantId: 't1',
      workspaceId: 'ws1',
      applicationId: 'app1',
      sessionId,
      userId: 'u-1',
      agent: 'care-nav',
    });
  const sendReferral = guard(async function send_referral(input: {
    patientId: string;
    to: string;
  }) {
    calls.push(input.patientId);
    return `sent ${input.patientId} to ${input.to}`;
  });

  before(() => registerOtelContextGlobals());
  beforeEach(async () => {
    stub = await new VerifyStub().start();
    mem = setup();
    calls = [];
  });
  afterEach(async () => {
    await stub.stop();
    resetGuardConfig();
  });
  after(() => resetGuardConfig());

  // --- the request ---

  it('checks an allowed call before and after, with the run’s identity', async () => {
    configure();
    const trace = newTrace();
    const out = await trace.activate(() =>
      sendReferral({ patientId: 'p-1', to: 'gp@stmarys.health' })
    );
    trace.end();
    assert.equal(out, 'sent p-1 to gp@stmarys.health');
    assert.deepEqual(stub.stages(), ['TOOL_CALL:send_referral', 'TOOL_RESULT:send_referral']);
    const [pre, post] = stub.requests;
    assert.equal(pre!.path, '/api/t/t1/verify');
    assert.equal(pre!.headers.authorization, 'Bearer dh-test');
    assert.equal(pre!.body.sessionId, 's-1');
    assert.equal(pre!.body.userId, 'u-1');
    assert.equal(pre!.body.source, 'care-nav');
    assert.equal(pre!.body.applicationId, 'app1');
    assert.deepEqual(pre!.body.tool.arguments, { patientId: 'p-1', to: 'gp@stmarys.health' });
    assert.equal(post!.body.tool.result, 'sent p-1 to gp@stmarys.health');
    assert.equal(pre!.body.tool.callId, post!.body.tool.callId);
  });

  it('sends only the first (input) argument by default, or what `args` builds', async () => {
    configure();
    const withContext = guard(async function lookup(input: { id: string }, _runContext: object) {
      return input.id;
    });
    const positional = guard(async function add(a: number, b: number) {
      return a + b;
    });
    const mapped = guard(async (a: number, b: number) => a * b, {
      name: 'multiply',
      args: (a, b) => ({ a, b }),
    });
    await newTrace().activate(async () => {
      await withContext({ id: 'x' }, { secret: 'framework state' });
      await positional(1, 2);
      await mapped(3, 4);
    });
    const args = stub.requests
      .filter((r) => r.body.stage === 'TOOL_CALL')
      .map((r) => r.body.tool.arguments);
    assert.deepEqual(args, [{ id: 'x' }, { args: [1, 2] }, { a: 3, b: 4 }]);
  });

  it('sends a large result truncated', async () => {
    configure({ maxResultBytes: 100 });
    const big = guard(async function read_file() {
      return 'x'.repeat(10_000);
    });
    await newTrace().activate(() => big());
    const result = stub.requests[1]!.body.tool.result as {
      truncated: boolean;
      bytes: number;
      head: string;
    };
    assert.equal(result.truncated, true);
    assert.equal(result.bytes, 10_002);
    assert.equal(result.head.length, 100);
  });

  // --- decisions ---

  it('a deny before the call means the function never runs', async () => {
    configure();
    stub.deny('TOOL_CALL', 'send_referral');
    const out = await newTrace().activate(() =>
      sendReferral({ patientId: 'p-1', to: 'x@other.example' })
    );
    assert.deepEqual(calls, []);
    assert.equal(
      out,
      'Blocked by Darkhunt: No sending outside the care team. The send_referral tool was not run.'
    );
    assert.deepEqual(stub.stages(), ['TOOL_CALL:send_referral']);
  });

  it('a deny after the call withholds the output', async () => {
    configure();
    stub.deny('TOOL_RESULT', 'send_referral', 'Patient data in tool output');
    const out = await newTrace().activate(() => sendReferral({ patientId: 'p-1', to: 'gp@x' }));
    assert.deepEqual(calls, ['p-1']);
    assert.match(String(out), /^Withheld by Darkhunt: Patient data in tool output\./);
  });

  it('shadow mode records a deny but runs the tool', async () => {
    configure({ mode: 'shadow' });
    stub.deny('TOOL_CALL', 'send_referral');
    const trace = newTrace();
    const out = await trace.activate(() => sendReferral({ patientId: 'p-1', to: 'x' }));
    trace.end();
    assert.equal(out, 'sent p-1 to x');
    const [check] = byName(mem.exporter, 'darkhunt.guard.tool_call');
    assert.equal(check!.attributes[META + 'guard.blocked'], false);
    assert.match(String(check!.attributes[ATTR.STATUS_MESSAGE]), /^Would block \(shadow\)/);
  });

  it('observed rules are reported without blocking', async () => {
    configure();
    stub.observe('TOOL_RESULT', 'send_referral', 'Patient data in tool output');
    const seen: Verdict[] = [];
    configure({ onVerdict: (v) => seen.push(v) });
    const trace = newTrace();
    const out = await trace.activate(() => sendReferral({ patientId: 'p-1', to: 'x' }));
    trace.end();
    assert.equal(out, 'sent p-1 to x');
    assert.deepEqual(
      seen.at(-1)!.observedRules.map((r) => r.ruleName),
      ['Patient data in tool output']
    );
    const [check] = byName(mem.exporter, 'darkhunt.guard.tool_result');
    assert.equal(check!.attributes[ATTR.OBSERVATION_LEVEL], 'WARNING');
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
      const out = await newTrace().activate(() => sendReferral({ patientId: 'p-1', to: 'x' }));
      assert.equal(calls.length === 1, runs, `fail=${fail}`);
      if (!runs) assert.match(String(out), /^Blocked by Darkhunt: Darkhunt unavailable/);
    }
  });

  it('onDeny can throw or return what a function gives', async () => {
    configure();
    stub.deny('TOOL_CALL', 'get_labs');
    const throwing = guard(
      async function get_labs() {
        return ['hba1c'];
      },
      { onDeny: 'throw' }
    );
    const empty = guard(
      async function get_labs() {
        return ['hba1c'];
      },
      { onDeny: () => [] as string[] }
    );
    await newTrace().activate(async () => {
      await assert.rejects(throwing(), (err: unknown) => {
        assert.ok(err instanceof DarkhuntBlockedError);
        assert.equal(err.verdict.stage, 'TOOL_CALL');
        return true;
      });
      assert.deepEqual(await empty(), []);
    });
  });

  it('off mode makes no calls', async () => {
    configure({ mode: 'off' });
    assert.equal(await sendReferral({ patientId: 'p-1', to: 'x' }), 'sent p-1 to x');
    assert.equal(stub.requests.length, 0);
  });

  // --- recording ---

  it('records each check under a tool span, and marks a blocked tool', async () => {
    configure();
    stub.deny('TOOL_CALL', 'send_referral');
    const trace = newTrace();
    await trace.activate(() => sendReferral({ patientId: 'p-1', to: 'x' }));
    trace.end();
    const [tool] = byName(mem.exporter, 'send_referral');
    const [check] = byName(mem.exporter, 'darkhunt.guard.tool_call');
    const [root] = byName(mem.exporter, 'agent');
    assert.equal(tool!.attributes[ATTR.OBSERVATION_TYPE], 'tool');
    assert.equal(tool!.parentSpanContext?.spanId, root!.spanContext().spanId);
    assert.equal(check!.parentSpanContext?.spanId, tool!.spanContext().spanId);
    assert.equal(check!.attributes[ATTR.OBSERVATION_TYPE], 'guardrail');
    assert.equal(check!.attributes[META + 'guard.decision'], 'DENY');
    assert.equal(check!.attributes[META + 'guard.rule_name'], 'No sending outside the care team');
    assert.equal(tool!.attributes[ATTR.OBSERVATION_LEVEL], 'WARNING');
    assert.equal(tool!.attributes[META + 'guard.blocked_at'], 'TOOL_CALL');
    assert.equal(tool!.attributes[META + 'guard.executed'], false);
  });

  it('reuses an existing span for the same tool instead of nesting a second one', async () => {
    configure();
    const trace = newTrace();
    await trace.startActiveSpan(
      'send_referral',
      { observationType: 'tool', toolName: 'send_referral' },
      () => sendReferral({ patientId: 'p-1', to: 'gp@x' })
    );
    trace.end();
    const tools = byName(mem.exporter, 'send_referral');
    assert.equal(tools.length, 1);
    const checks = mem.exporter
      .getFinishedSpans()
      .filter((s) => s.name.startsWith('darkhunt.guard.'));
    assert.deepEqual(
      new Set(checks.map((c) => c.parentSpanContext?.spanId)),
      new Set([tools[0]!.spanContext().spanId])
    );
  });

  it('outside a run, checks still go out on the configured routing', async () => {
    configure({ tenantId: 't9', workspaceId: 'ws9', applicationId: 'app9' });
    assert.equal(await sendReferral({ patientId: 'p-1', to: 'x' }), 'sent p-1 to x');
    assert.equal(stub.requests[0]!.path, '/api/t/t9/verify');
    assert.equal(stub.requests[0]!.body.applicationId, 'app9');
    assert.equal(stub.requests[0]!.body.sessionId, undefined);
  });

  // --- context and declaration ---

  it('trace.activate makes the trace current and restores the previous context', async () => {
    const trace = newTrace();
    assert.equal(currentObservation(), undefined);
    await trace.activate(async () => {
      assert.equal(currentObservation(), trace);
      await trace.startActiveSpan('step', (span) => assert.equal(currentObservation(), span));
      assert.equal(currentObservation(), trace);
    });
    assert.equal(currentObservation(), undefined);
    trace.end();
  });

  it('wraps sync functions too (the guarded function is async)', async () => {
    configure();
    const add = guard(function add(input: { a: number; b: number }) {
      return input.a + input.b;
    });
    assert.equal(await newTrace().activate(() => add({ a: 2, b: 3 })), 5);
  });

  it('enforce needs a fail mode, and an anonymous function needs a name', () => {
    assert.throws(() => configureGuard({ mode: 'enforce' }), /needs a fail mode/);
    assert.throws(() => guard(async () => 1), /needs a name/);
  });
});
