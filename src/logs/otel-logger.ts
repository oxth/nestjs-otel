import { ConsoleLogger, type ConsoleLoggerOptions, Injectable, type LogLevel, Optional } from '@nestjs/common';
import { context as otelContext, isSpanContextValid, logs, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { inspect } from 'node:util';
import { formatStack, hasStackRecorded, markStackRecorded } from '../errors/record';
import { SCOPE_NAME } from '../shared/constants';
import { safely } from '../shared/safe';
import { toSeverity } from './severity';

export interface OtelLoggerOptions extends ConsoleLoggerOptions {
  /** Print to stdout/stderr like Nest's `ConsoleLogger`. Default `true`. */
  console?: boolean;
  /** Emit each log as an OpenTelemetry log record (exported over OTLP by the SDK). Default `true`. */
  otlp?: boolean;
}

function activeSpan(): Span | undefined {
  const span = trace.getActiveSpan();
  return span && isSpanContextValid(span.spanContext()) ? span : undefined;
}

function toBody(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message instanceof Error) return message.message;
  try {
    const json = JSON.stringify(message);
    if (typeof json === 'string') return json;
  } catch {
    // circular, BigInt, throwing toJSON: fall back to inspect
  }
  return inspect(message);
}

/**
 * Nest `ConsoleLogger` that correlates logs with traces: console lines get
 * ` trace_id=… span_id=…` while a span is active, every log is also emitted as an
 * OpenTelemetry log record, and `error(message, stack)` records an `exception`
 * event on the active span unless that error was already recorded in the trace.
 */
@Injectable()
export class OtelLogger extends ConsoleLogger {
  private readonly consoleEnabled: boolean;
  private readonly otlpEnabled: boolean;

  constructor(@Optional() context?: string, @Optional() options?: OtelLoggerOptions) {
    const { console: consoleEnabled = true, otlp = true, ...consoleOptions } = options ?? {};
    // ConsoleLogger treats an options-only call differently from (context, options).
    if (context) super(context, consoleOptions);
    else super(consoleOptions);
    this.consoleEnabled = consoleEnabled;
    this.otlpEnabled = otlp;
  }

  // Called by every level method once the level is enabled, with the parsed arguments.
  protected override printMessages(
    messages: unknown[],
    context = '',
    logLevel: LogLevel = 'log',
    writeStreamType?: 'stdout' | 'stderr',
    errorStack?: unknown,
    ...rest: [params?: Record<string, unknown>]
  ): void {
    // Resolve lazy messages once, so a message function isn't called again for the console.
    const resolved = safely('otel logger resolve', () => messages.map((m) => this.resolve(m)), messages);
    safely('otel logger telemetry', () => this.recordTelemetry(resolved, context, logLevel, errorStack), undefined);
    if (this.consoleEnabled) super.printMessages(resolved, context, logLevel, writeStreamType, errorStack, ...rest);
  }

  protected override printStackTrace(stack: string): void {
    if (this.consoleEnabled) super.printStackTrace(stack);
  }

  protected override formatMessage(
    logLevel: LogLevel,
    message: unknown,
    pidMessage: string,
    formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string,
    ...rest: [params?: Record<string, unknown>]
  ): string {
    const line = super.formatMessage(
      logLevel,
      message,
      pidMessage,
      formattedLogLevel,
      contextMessage,
      timestampDiff,
      ...rest,
    );
    const suffix = safely('otel logger trace suffix', () => this.traceSuffix(), '');
    if (!suffix) return line;
    return line.endsWith('\n') ? `${line.slice(0, -1)}${suffix}\n` : `${line}${suffix}`;
  }

  protected override getJsonLogObject(
    message: unknown,
    options: Parameters<ConsoleLogger['printAsJson']>[1],
  ): ReturnType<ConsoleLogger['getJsonLogObject']> {
    const object = super.getJsonLogObject(message, options);
    const ctx = safely('otel logger json trace fields', () => activeSpan()?.spanContext(), undefined);
    if (ctx) Object.assign(object, { trace_id: ctx.traceId, span_id: ctx.spanId });
    return object;
  }

  private traceSuffix(): string {
    const ctx = activeSpan()?.spanContext();
    return ctx ? ` trace_id=${ctx.traceId} span_id=${ctx.spanId}` : '';
  }

  private recordTelemetry(messages: unknown[], context: string, logLevel: LogLevel, errorStack: unknown): void {
    const redacted = messages.map((m) => this.redactForTelemetry(m));
    if (this.otlpEnabled) {
      const { severityNumber, severityText } = toSeverity(logLevel);
      const logger = logs.getLogger(SCOPE_NAME);
      const active = otelContext.active();
      for (const message of redacted) {
        logger.emit({
          severityNumber,
          severityText,
          body: toBody(message),
          ...(context && { attributes: { 'nest.context': context } }),
          context: active,
        });
      }
    }
    if (logLevel === 'error') this.recordException(redacted[0], errorStack);
  }

  private recordException(message: unknown, errorStack: unknown): void {
    const span = activeSpan();
    if (!span) return;
    // `logger.error(err)` (how Nest's ExceptionsHandler logs) passes the error itself.
    const stack = typeof errorStack === 'string' ? errorStack : message instanceof Error ? formatStack(message) : undefined;
    if (stack === undefined || hasStackRecorded(span, stack)) return;
    const text = toBody(message);
    span.addEvent('exception', {
      ...(message instanceof Error && { 'exception.type': message.constructor?.name || message.name }),
      'exception.message': text,
      'exception.stacktrace': stack,
    });
    span.setStatus({ code: SpanStatusCode.ERROR, message: text });
    markStackRecorded(span, stack);
  }

  // Lazy (function) messages and `redact` exist on Nest 12's ConsoleLogger only.
  private resolve(message: unknown): unknown {
    const self = this as unknown as { resolveMessage?: (m: unknown) => unknown };
    return typeof self.resolveMessage === 'function' ? self.resolveMessage(message) : message;
  }

  private redactForTelemetry(message: unknown): unknown {
    const self = this as unknown as { redact?: (v: unknown) => unknown };
    return typeof self.redact === 'function' ? self.redact(message) : message;
  }
}
