import express from 'express';
import { query } from '../db.js';

const router = express.Router();

router.post('/', async (req, res, next) => {
  const { name, email } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }
  try {
    const result = await query(
      'INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id, name, email, created_at',
      [name, email],
      'insert_user'
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'email already exists' });
    }
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const result = await query(
      'SELECT id, name, email, created_at FROM users WHERE id = $1',
      [req.params.id],
      'get_user'
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'user not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

export default router;
