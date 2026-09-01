import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';

const SERVICE_NAME = 'worker';

// The worker has no HTTP surface, so there's no middleware here - the
// correlation ID arrives on the AMQP message's correlationId property and
// the consume loop opens the context itself.
export const requestContext = new AsyncLocalStorage();

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: SERVICE_NAME },
  messageKey: 'message',
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  formatters: {
    level: (label) => ({ level: label }),
  },
  serializers: { err: pino.stdSerializers.err },
  mixin() {
    const store = requestContext.getStore();
    return store?.requestId ? { requestId: store.requestId } : {};
  },
});

export function getRequestId() {
  return requestContext.getStore()?.requestId;
}
