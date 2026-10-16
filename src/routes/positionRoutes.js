const express = require('express');
const {
  getPositions,
  getPositionBySymbol,
  closePosition,
} = require('../controllers/positionController');
const { protect } = require('../middlewares/authMiddleware');

const router = express.Router();

router.use(protect);

router.get('/', getPositions);
router.get('/:symbol', getPositionBySymbol);
router.post('/:symbol/close', closePosition);

module.exports = router;
