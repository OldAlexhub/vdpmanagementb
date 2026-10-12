import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import api from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import mongoose from 'mongoose';
import { csrfProtection, structuredRequestLog } from './middleware/security.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const defaultClientOrigins = [
  'http://localhost:3000',
  'https://vdpmanagementf.onrender.com',
];

export function clientOrigins() {
  const configured = (process.env.CLIENT_ORIGIN || '').split(',');
  return [...new Set([...defaultClientOrigins, ...configured]
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean))];
}

export function createApp() {
  const app = express();
  const origins = clientOrigins();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", ...origins],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
  }));
  app.use(cors({ origin: origins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(structuredRequestLog);
  app.use(csrfProtection(origins));

  app.get('/api/health', (_req, res) => {
    const databaseReady = mongoose.connection.readyState === 1;
    res.status(databaseReady ? 200 : 503).json({ ok: databaseReady, database: databaseReady ? 'ready' : 'unavailable' });
  });
  app.use('/api', api);
  app.use('/api', notFoundHandler);

  // Serve the built React app in production (client/build).
  const build = path.resolve(here, '../../client/build');
  if (fs.existsSync(build)) {
    app.use(express.static(build));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(build, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
