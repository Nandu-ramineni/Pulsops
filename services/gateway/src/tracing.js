// OpenTelemetry bootstrap. This module MUST be loaded before anything else
// so the auto-instrumentations can patch http/express/pg/redis/amqplib as
// they are imported - hence `node --import ./src/tracing.js src/index.js`
// in the Dockerfile rather than a plain `import` from index.js.
//
// Configuration is entirely environment-driven (OTEL_SERVICE_NAME,
// OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_TRACES_EXPORTER), which keeps this file
// identical across all four services and matches how you would configure a
// collector in production.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

// ESM does not go through require(), so OpenTelemetry cannot monkey-patch
// imported modules without a loader hook. Without this, http/express are
// never instrumented and cross-service trace propagation silently breaks -
// pg still works, which makes the failure easy to miss.
//
// Registered here via node:module register() rather than passing
// --experimental-loader on the command line: the flag works but prints an
// ExperimentalWarning to stderr, which would put non-JSON lines into the
// log stream Loki collects.
register('@opentelemetry/instrumentation/hook.mjs', pathToFileURL('./'));

const sdk = new NodeSDK({
  instrumentations: [
    getNodeAutoInstrumentations({
      // Filesystem spans are pure noise at this granularity and would bury
      // the request spans we actually care about.
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();

process.on('SIGTERM', () => {
  sdk.shutdown().finally(() => process.exit(0));
});
