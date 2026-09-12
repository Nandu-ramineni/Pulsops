import 'dotenv/config';
import express from 'express';
import pino from 'pino';

// This service exists because we don't have real Slack/PagerDuty credentials
// to wire into Alertmanager, and faking a "message sent to Slack" log line
// would violate the one rule this whole project runs on: never invent
// results. Instead this is a REAL webhook target that Alertmanager REALLY
// POSTs to - so routing, grouping, and inhibition can be verified against
// actual HTTP deliveries instead of trusted on faith. Swapping this for a
// genuine Slack/email receiver later is a config change in
// observability/alertmanager/alertmanager.yml, not an architecture change.
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'alert-receiver' },
  messageKey: 'message',
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  formatters: { level: (label) => ({ level: label }) },
});

const app = express();
const PORT = process.env.PORT || 4004;

// Alertmanager's webhook payload can carry many alerts per delivery once
// grouped, so this needs a reasonably generous body limit.
app.use(express.json({ limit: '2mb' }));

const MAX_HISTORY = 200;
const history = [];

app.post('/webhook', (req, res) => {
  const payload = req.body || {};
  const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];

  const record = {
    receivedAt: new Date().toISOString(),
    receiver: payload.receiver,
    status: payload.status,
    groupLabels: payload.groupLabels,
    commonLabels: payload.commonLabels,
    alertCount: alerts.length,
    alerts: alerts.map((a) => ({
      status: a.status,
      alertname: a.labels?.alertname,
      severity: a.labels?.severity,
      notify: a.labels?.notify,
      summary: a.annotations?.summary,
    })),
  };

  history.unshift(record);
  history.length = Math.min(history.length, MAX_HISTORY);

  // notify=page vs notify=ticket is what a real integration would use to
  // pick Slack channel / PagerDuty routing key / email distribution list.
  // Logged explicitly here so it's visible which "channel" each delivery
  // would have gone to.
  logger.info(
    {
      receiver: payload.receiver,
      status: payload.status,
      notify: payload.commonLabels?.notify,
      groupLabels: payload.groupLabels,
      alertCount: alerts.length,
      alertnames: record.alerts.map((a) => a.alertname),
    },
    'received alertmanager webhook'
  );

  res.status(200).json({ received: alerts.length });
});

app.get('/alerts', (_req, res) => {
  res.json(history);
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'alert-receiver' });
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'alert-receiver listening');
});
