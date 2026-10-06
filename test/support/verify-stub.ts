/**
 * A `/verify` stand-in for guard tests: records each request and answers from
 * `rules`, a `${stage}:${tool}` → response map (ALLOW when absent).
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: {
    stage: string;
    sessionId?: string;
    userId?: string;
    source?: string;
    applicationId?: string;
    tool: { name: string; callId: string; arguments: unknown; result?: unknown };
  };
}

export class VerifyStub {
  readonly requests: RecordedRequest[] = [];
  readonly rules = new Map<string, Record<string, unknown>>();
  private server?: Server;
  url = '';

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = JSON.parse(raw) as RecordedRequest['body'];
        this.requests.push({ path: req.url ?? '', headers: req.headers, body });
        const answer = this.rules.get(`${body.stage}:${body.tool.name}`) ?? { decision: 'ALLOW' };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ stage: body.stage, failed: false, ...answer }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this;
  }

  deny(stage: string, tool: string, rule = 'No sending outside the care team'): void {
    this.rules.set(`${stage}:${tool}`, {
      decision: 'DENY',
      matchedRules: [{ ruleId: 'r-1', ruleName: rule, action: 'DENY' }],
    });
  }

  observe(stage: string, tool: string, rule: string): void {
    this.rules.set(`${stage}:${tool}`, {
      decision: 'ALLOW',
      observedRules: [{ ruleId: 'r-2', ruleName: rule, action: 'DENY' }],
    });
  }

  stages(): string[] {
    return this.requests.map((r) => `${r.body.stage}:${r.body.tool.name}`);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
