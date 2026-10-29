import { Router } from 'express';
import { getCallByIdController, listCallsController } from '../controllers/callRecords.controller.js';
import { requireCallRecordsApiKey } from '../middleware/requireCallRecordsApiKey.js';

export const callRecordsRouter: Router = Router();

callRecordsRouter.use(requireCallRecordsApiKey);

callRecordsRouter.get('/', (req, res, next) => {
  listCallsController(req, res).catch(next);
});

callRecordsRouter.get('/:id', (req, res, next) => {
  getCallByIdController(req, res).catch(next);
});
