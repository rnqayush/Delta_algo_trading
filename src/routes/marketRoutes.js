const express = require('express');
const { getTicker, getProducts } = require('../controllers/marketController');

const router = express.Router();

// Market data is public: no API keys and no login are required.
router.get('/ticker', getTicker);
router.get('/products', getProducts);

module.exports = router;
