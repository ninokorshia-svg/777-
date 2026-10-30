import express from 'express';
import type { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { handleApiRequest } from './src/backend/apiHandler.ts';
import { createNodeSqliteD1 } from './src/backend/nodeSqliteAdapter.ts';
import type { Env } from './src/backend/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isProd = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Initialize D1-compatible SQLite database
const dbPath = path.join(process.cwd(), 'data', 'physics_quiz.sqlite');
const db = createNodeSqliteD1(dbPath);

const env: Env = {
  DB: db,
  TEACHER_ENROLLMENT_SECRET: process.env.TEACHER_ENROLLMENT_SECRET || 'PhysicsAdminKey2026!',
  SESSION_EXPIRATION_HOURS: process.env.SESSION_EXPIRATION_HOURS ? parseInt(process.env.SESSION_EXPIRATION_HOURS, 10) : 72,
  NODE_ENV: process.env.NODE_ENV
};

async function startServer() {
  const app = express();
  // Parse raw body for bridging to web standard Request
  app.use(express.raw({ type: '*/*', limit: '10mb' }));

  // API router bridged to universal Web Request/Response handler
  app.all(['/api', '/api/*'], async (req: Request, res: Response) => {
    try {
      const xForwardedHost = req.headers['x-forwarded-host'];
      const rawHost = Array.isArray(xForwardedHost) 
        ? xForwardedHost[0] 
        : (typeof xForwardedHost === 'string' ? xForwardedHost : req.headers.host || `localhost:${PORT}`);
      const host = rawHost.split(',')[0].trim();

      const xForwardedProto = req.headers['x-forwarded-proto'];
      const rawProto = Array.isArray(xForwardedProto)
        ? xForwardedProto[0]
        : (typeof xForwardedProto === 'string' ? xForwardedProto : req.protocol || 'http');
      const protocol = rawProto.split(',')[0].trim();

      const url = `${protocol}://${host}${req.originalUrl}`;

      const headers = new Headers();
      for (const [key, val] of Object.entries(req.headers)) {
        if (val !== undefined) {
          if (Array.isArray(val)) {
            val.forEach(v => headers.append(key, v));
          } else {
            headers.set(key, val);
          }
        }
      }

      const method = req.method.toUpperCase();
      const body = (method === 'GET' || method === 'HEAD') 
        ? undefined 
        : (req.body && Buffer.isBuffer(req.body) && req.body.length > 0 ? new Uint8Array(req.body) : undefined);

      const webRequest = new Request(url, {
        method,
        headers,
        body
      });

      const webResponse = await handleApiRequest(webRequest, db, env);

      res.status(webResponse.status);
      if (typeof (webResponse.headers as any).getSetCookie === 'function') {
        const cookies = (webResponse.headers as any).getSetCookie();
        cookies.forEach((c: string) => res.append('Set-Cookie', c));
      } else {
        const setCookie = webResponse.headers.get('set-cookie');
        if (setCookie) res.setHeader('Set-Cookie', setCookie);
      }
      webResponse.headers.forEach((value, name) => {
        if (name.toLowerCase() !== 'set-cookie') {
          res.setHeader(name, value);
        }
      });

      const responseBuffer = Buffer.from(await webResponse.arrayBuffer());
      res.end(responseBuffer);
    } catch (err) {
      console.error('API bridge error:', err);
      res.status(500).json({ error: 'შიდა სერვერული შეცდომა' });
    }
  });

  // Vite integration
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req: Request, res: Response) => {
        res.sendFile(path.resolve(distPath, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Quiz Server is running on http://0.0.0.0:${PORT} (D1/SQLite Engine Active)`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
