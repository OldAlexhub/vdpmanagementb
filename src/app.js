import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import api from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const defaultClientOrigins = [
  'http://localhost:3000',
  'https://vdpmanagementf.onrender.com',
];

function clientOrigins() {
  const configured = (process.env.CLIENT_ORIGIN || '').split(',');
  return [...new Set([...defaultClientOrigins, ...configured]
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean))];
}

export function createApp() {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: clientOrigins(), credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

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
