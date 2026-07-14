// Vercel serverless entry point. The Express app (server/index.js) only binds a
// port when run directly, so importing it here yields the request handler that
// Vercel invokes for every /api/* route (see vercel.json rewrites).
import app from '../server/index.js';

export default app;
