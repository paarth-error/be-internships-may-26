import Fastify from 'fastify';
import dotenv from 'dotenv';
import { postSignal, getSignals } from './signals.js';

dotenv.config();

const API_KEY = process.env.API_KEY || 'change-me';
const PORT = Number(process.env.PORT || 8080);

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
  },
});

// ---------------------------------------------------------------------------
// Auth hook — validate X-API-Key on every request except /healthz
// ---------------------------------------------------------------------------
app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/healthz') return;
  const key = req.headers['x-api-key'];
  if (!key || key !== API_KEY) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/healthz', async () => ({ ok: true }));
app.post('/v1/signals', postSignal);
app.get('/v1/signals', getSignals);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen({ host: '0.0.0.0', port: PORT }).catch((e) => {
  app.log.error(e);
  process.exit(1);
});

export default app;
