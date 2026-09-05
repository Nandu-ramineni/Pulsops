import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import pino from 'pino';

const SERVICE_NAME = 'user-service';
export const REQUEST_ID_HEADER = 'x-request-id';

// AsyncLocalStorage carries the current request's correlation ID implicitly,
// so every log line picks it up without threading a logger (or a requestId
// argument) through every function signature.
export const requestContext = new AsyncLocalStorage();

// Node raises an AggregateError when a connection attempt tries several
// addresses and all of them fail - and its .message is an EMPTY string, with
// the real causes hidden in .errors. Left alone that produces a blank error
// message in the logs, which is the worst thing to hit mid-incident.
export function describeError(err) {
  if (err?.message) return err.message;
  if (Array.isArray(err?.errors) && err.errors.length > 0) {
    const causes = [...new Set(err.errors.map((e) => e?.message).filter(Boolean))];
    if (causes.length > 0) return `${err.name || 'AggregateError'}: ${causes.join('; ')}`;
  }
  return err?.code || err?.name || 'unknown error';
}

function serializeError(err) {
  const serialized = pino.stdSerializers.err(err);
  // pino already expands an AggregateError's causes into `aggregateErrors`,
  // but leaves the empty top-level message untouched - repair just that, so
  // the summary line is readable without duplicating the cause detail.
  if (!serialized.message) serialized.message = describeError(err);
  return serialized;
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: SERVICE_NAME },
  messageKey: 'message',
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  formatters: {
    level: (label) => ({ level: label }),
  },
  serializers: { err: serializeError },
  // Only requestId is added here. trace_id/span_id/trace_flags are injected
  // automatically by @opentelemetry/instrumentation-pino (part of the auto
  // instrumentations enabled in tracing.js), using OpenTelemetry's own
  // snake_case field names - duplicating them here produced two copies of
  // the same value on every single log line.
  mixin() {
    const store = requestContext.getStore();
    return store?.requestId ? { requestId: store.requestId } : {};
  },
});

export function getRequestId() {
  return requestContext.getStore()?.requestId;
}

// Accepts an inbound x-request-id so one logical user action keeps a single
// correlation ID across every service it touches; only generates a new one
// when this service is the entry point.
export function requestLoggingMiddleware(req, res, next) {
  const requestId = req.headers[REQUEST_ID_HEADER] || randomUUID();
  // Written back onto req.headers so outbound proxying/fetch calls forward it.
  req.headers[REQUEST_ID_HEADER] = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  requestContext.run({ requestId }, () => {
    if (req.path === '/health' || req.path === '/metrics') return next();

    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const details = {
        method: req.method,
        route: req.route ? `${req.baseUrl}${req.route.path}` : req.baseUrl || req.path,
        statusCode: res.statusCode,
        durationMs: Number(durationMs.toFixed(2)),
      };
      if (res.statusCode >= 500) logger.error(details, 'request failed');
      else if (res.statusCode >= 400) logger.warn(details, 'request completed with client error');
      else logger.info(details, 'request completed');
    });

    next();
  });
}
