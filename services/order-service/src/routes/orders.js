import express from 'express';
import { pool } from '../db.js';
import { getUser } from '../userClient.js';
import { publishOrderCreated } from '../queue.js';

const router = express.Router();

router.post('/', async (req, res, next) => {
  const { userId, item, quantity } = req.body;
  if (!userId || !item || !quantity) {
    return res.status(400).json({ error: 'userId, item and quantity are required' });
  }

  try {
    const { user } = await getUser(userId);
    if (!user) {
      return res.status(404).json({ error: `user ${userId} not found` });
    }

    const result = await pool.query(
      `INSERT INTO orders (user_id, item, quantity, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING id, user_id, item, quantity, status, created_at`,
      [userId, item, quantity]
    );
    const order = result.rows[0];

    await publishOrderCreated(order);

    res.status(202).json(order);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, user_id, item, quantity, status, created_at, updated_at FROM orders WHERE id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'order not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

export default router;
