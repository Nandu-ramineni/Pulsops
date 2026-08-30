import pg from 'pg';
import { dbQueryDuration, dbQueriesFailedTotal, registerDbPoolMetrics } from './metrics.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
registerDbPoolMetrics(pool);

export async function query(text, params, operation = 'query') {
  const end = dbQueryDuration.startTimer({ operation });
  try {
    const result = await pool.query(text, params);
    end({ status: 'success' });
    return result;
  } catch (err) {
    end({ status: 'error' });
    dbQueriesFailedTotal.inc({ operation });
    throw err;
  }
}
