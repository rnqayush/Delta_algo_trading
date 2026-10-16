const express = require('express');
const { getStrategies, startStrategy, stopStrategy } = require('../controllers/strategyController');
const { protect } = require('../middlewares/authMiddleware');

const router = express.Router();

router.use(protect);

router.get('/', getStrategies);
router.post('/:name/start', startStrategy);
router.post('/:name/stop', stopStrategy);

module.exports = router;
