const express = require('express');
const { createOrder, getOrders, getOrder, cancelOrder } = require('../controllers/orderController');
const { protect } = require('../middlewares/authMiddleware');

const router = express.Router();

// Trading endpoints require a logged-in user.
router.use(protect);

router.post('/', createOrder);
router.get('/', getOrders);
router.get('/:id', getOrder);
router.delete('/:id', cancelOrder);

module.exports = router;
