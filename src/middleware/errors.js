import mongoose from 'mongoose';
import { HttpError } from '../services/errors.js';

export function notFoundHandler(req, _res, next) {
  next(new HttpError(404, `No API route for ${req.method} ${req.originalUrl}.`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err instanceof mongoose.Error.ValidationError) {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({ error: messages.join(' ') });
  }
  if (err instanceof mongoose.Error.CastError) {
    return res.status(400).json({ error: `Invalid value for ${err.path}.` });
  }
  if (err?.code === 11000) {
    const field = Object.keys(err.keyValue || {}).join(', ');
    return res.status(409).json({ error: `A record with this ${field || 'value'} already exists.` });
  }
  if (err?.name === 'MulterError') {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  return res.status(500).json({ error: 'Something went wrong on the server.' });
}
