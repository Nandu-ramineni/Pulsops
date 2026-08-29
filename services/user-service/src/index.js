require('dotenv').config();
const express = require('express');
const { pool } = require('./db');
const usersRouter = require('./routes/users');

const app = express();
const PORT = process.env.PORT || 4001;

app.use(express.json());

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'user-service' });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', service: 'user-service', error: err.message });
  }
});

app.use('/users', usersRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

app.listen(PORT, () => {
  console.log(`user-service listening on ${PORT}`);
});
