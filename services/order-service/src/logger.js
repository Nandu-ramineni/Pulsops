import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import pino from 'pino';

const SERVICE_NAME = 'order-service';
export const REQUEST_ID_HEADER = 'x-request-id';

// AsyncLocalStorage carries the current request's correlation ID implicitly,
// so every log line picks it up without threading a logger (or a requestId
// argument) through every function signature.
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
