const express = require('express');
const { getConfig } = require('../store');

const router = express.Router();

router.get('/', (req, res) => {
  const config = getConfig();
  res.json({
    kite: { apiKey: config.kite.apiKey },
    telegram: {},
  });
});

module.exports = router;
