import express from 'express';
import { query } from '../db.js';
import { getUser } from '../userClient.js';
import { publishOrderCreated } from '../queue.js';
import { logger } from '../logger.js';

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

    const result = await query(
      `INSERT INTO orders (user_id, item, quantity, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING id, user_id, item, quantity, status, created_at`,
      [userId, item, quantity],
      'insert_order'
    );
    const order = result.rows[0];
    logger.info({ orderId: order.id, userId, item, quantity }, 'order created');

    await publishOrderCreated(order);

    res.status(202).json(order);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const result = await query(
      'SELECT id, user_id, item, quantity, status, created_at, updated_at FROM orders WHERE id = $1',
      [req.params.id],
      'get_order'
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
