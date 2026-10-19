/** Opt-in OpenTelemetry tracing for the compiler pipeline (owner directive, plan-notes 187).
 *
 * Off by default: `STATOR_OTEL` unset means this module's dynamic imports never run and the
 * pipeline's startup floor — a benchmarked product metric (plan.md §9 Task 6.3) — stays untouched.
 * On: standard OTel env config (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`,
 * `OTEL_SERVICE_NAME`) applies, which is precisely what Maple and every other OTLP-compatible
 * backend consume; nothing here is vendor-specific.
 *
 * A telemetry misconfiguration must never break a compile: init failures degrade to a warning
 * and no tracing, because the compiler's output correctness never depends on its observability.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { SpanStatusCode, type Span, trace } from '@opentelemetry/api';

let provider: { shutdown(): Promise<void> } | null = null;

/** Wall time per span name, present only while `STATOR_COMPILE_TIMING` is set.
 * Concurrent builds stay isolated: the store is the async context, not a global. */
const stageTimings = new AsyncLocalStorage<Map<string, number>>();

function noteStage(name: string, start: number, stages: Map<string, number> | undefined): void {
  if (stages === undefined) {
    return;
  }
  stages.set(name, (stages.get(name) ?? 0) + (performance.now() - start));
}

/** Run `fn` with stage timing and print one `stator: timing` line on the way out,
 * including when `fn` throws — a failed build's profile is the evidence. */
export async function runStageTimings<T>(fn: () => Promise<T>): Promise<T> {
  const stages = new Map<string, number>();
  try {
    return await stageTimings.run(stages, fn);
  } finally {
    if (stages.size > 0) {
      const parts: string[] = [];
      for (const [name, ms] of stages) {
        parts.push(`${name}=${ms.toFixed(1)}ms`);
      }
      process.stderr.write(`stator: timing ${parts.join(' ')}\n`);
    }
  }
}

/** Add time that is not itself a `withSpan` (the parallel clang pool's compile
 * versus the final link). No-op outside `runStageTimings`. */
export function addStageTime(name: string, ms: number): void {
  const stages = stageTimings.getStore();
  if (stages === undefined) {
    return;
  }
  stages.set(name, (stages.get(name) ?? 0) + ms);
}

function tracer(): ReturnType<typeof trace.getTracer> {
  return trace.getTracer('stator');
}

interface Stage {
  readonly span: Span;
  readonly stages: Map<string, number> | undefined;
  readonly start: number;
}

function startStage(name: string, attributes: Record<string, string>): Stage {
  const stages = stageTimings.getStore();
  return {
    span: tracer().startSpan(name, { attributes }),
    stages,
    start: stages === undefined ? 0 : performance.now(),
  };
}

function failStage(stage: Stage, error: unknown): never {
  stage.span.recordException(error instanceof Error ? error : String(error));
  stage.span.setStatus({ code: SpanStatusCode.ERROR });
  stage.span.end();
  throw error;
}

/** Registers the global provider when enabled; a no-op otherwise. Dynamic imports keep cold
 * startup and every test spawn free of the SDK's cost. */
export async function telemetryInit(): Promise<void> {
  if (process.env['STATOR_OTEL'] === undefined) {
    return;
  }
  try {
    const [{ OTLPTraceExporter }, { resourceFromAttributes }, sdkTraceNode] = await Promise.all([
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/sdk-trace-node'),
    ]);
    const p = new sdkTraceNode.NodeTracerProvider({
      resource: resourceFromAttributes({
        'service.name': process.env['OTEL_SERVICE_NAME'] ?? 'stator',
      }),
      spanProcessors: [new sdkTraceNode.SimpleSpanProcessor(new OTLPTraceExporter())],
    });
    p.register();
    provider = p;
  } catch (error) {
    process.stderr.write(`stator: telemetry disabled (${String(error)})\n`);
  }
}

/** Flushes and unregisters. Called on every exit path of the CLI; a no-op when disabled. */
export async function telemetryShutdown(): Promise<void> {
  await provider?.shutdown();
}

/** Sync span wrapper: the pipeline is synchronous, and an async envelope would cost every caller
 * its `await` chain for observability's sake alone. A throw is recorded on the span, rethrown,
 * and the span status goes ERROR — a failed stage is a span fact, not a swallowed exception. */
export function withSpan<T>(name: string, attributes: Record<string, string>, fn: () => T): T {
  const stage = startStage(name, attributes);
  try {
    const result = fn();
    stage.span.end();
    return result;
  } catch (error) {
    throw failStage(stage, error);
  } finally {
    noteStage(name, stage.start, stage.stages);
  }
}

/** `withSpan` for an async body. The sync form ends the span when `fn` returns, which for an
 * async function is the moment it hands back a pending promise — so this one awaits, and records
 * the rejection, before the span ends. */
export async function withSpanAsync<T>(
  name: string,
  attributes: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const stage = startStage(name, attributes);
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    noteStage(name, stage.start, stage.stages);
    throw failStage(stage, error);
  }
  stage.span.end();
  noteStage(name, stage.start, stage.stages);
  return result;
}
