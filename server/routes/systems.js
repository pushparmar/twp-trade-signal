const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getSystems, addSystem, updateSystem, deleteSystem } = require('../store');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(getSystems());
});

router.post('/', (req, res) => {
  const { name, chatId, exchange, product, quantity, autoPlace } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const system = {
    id: uuidv4(),
    name,
    chatId: chatId || null,
    exchange: exchange || 'NSE',
    product: product || 'CNC',
    quantity: parseInt(quantity, 10) || 1,
    autoPlace: Boolean(autoPlace),
  };
  res.status(201).json(addSystem(system));
});

router.put('/:id', (req, res) => {
  const updated = updateSystem(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'System not found' });
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  if (!deleteSystem(req.params.id)) return res.status(404).json({ error: 'System not found' });
  res.json({ ok: true });
});

module.exports = router;
