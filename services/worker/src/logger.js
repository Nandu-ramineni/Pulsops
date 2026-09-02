import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';

const SERVICE_NAME = 'worker';

// The worker has no HTTP surface, so there's no middleware here - the
// correlation ID arrives on the AMQP message's correlationId property and
// the consume loop opens the context itself.
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
  mixin() {
    const store = requestContext.getStore();
    return store?.requestId ? { requestId: store.requestId } : {};
  },
});

export function getRequestId() {
  return requestContext.getStore()?.requestId;
}
