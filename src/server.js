import process from 'node:process';
import { createServer } from 'node:http';

import { getConfig } from './config/env.js';
import { createSupabase } from './services/supabase.js';
import { createApp } from './app.js';

const SERVICE_NAME = 'hysmart-station-api';
const SHUTDOWN_TIMEOUT_MS = 10_000;
// Bind explicitly to 0.0.0.0 so Render / Fly / Docker always reach us
// regardless of whether Node would have picked :: or 127.0.0.1 by default.
const BIND_HOST = '0.0.0.0';

let server;
let shuttingDown = false;

function log(level, message, details = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    message,
    ...details,
  };
  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else console.log(line);
}

function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return port;
}

async function start() {
  const config = getConfig();
  const port = validatePort(config.port);
  const supabase = createSupabase(config);

  if (!supabase) {
    log('warn', 'Supabase credentials are missing; authenticated API routes will return service-not-configured errors.');
  }

  const app = createApp(config, supabase);
  if (typeof app !== 'function') {
    throw new TypeError('createApp(config, supabase) must return an Express request handler.');
  }

  server = createServer(app);
  server.headersTimeout = 60_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;

  server.on('clientError', (error, socket) => {
    log('warn', 'Invalid HTTP client request', {
      code: error.code || 'CLIENT_ERROR',
      message: error.message,
    });
    if (socket.destroyed || !socket.writable) return;
    const tooLarge = error.code === 'HPE_HEADER_OVERFLOW';
    socket.end(tooLarge
      ? 'HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n'
      : 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, BIND_HOST);
  });

  // Report subsequent listener/runtime errors instead of silently losing the API.
  server.on('error', (error) => {
    log('error', 'HTTP server error', {
      code: error.code || 'SERVER_ERROR',
      message: error.message,
    });
    process.exitCode = 1;
    if (server?.listening) {
      void shutdown('server-error');
    } else {
      // Nothing to drain — exit immediately rather than risk a hung loop.
      process.exit(1);
    }
  });

  const address = server.address();
  log('info', 'API server started successfully', {
    host: BIND_HOST,
    port,
    address: address && typeof address === 'object' ? address.address : undefined,
    nodeVersion: process.version,
    environment: config.nodeEnv || process.env.NODE_ENV || 'unspecified',
    supabaseConfigured: Boolean(supabase),
  });
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'Graceful shutdown started', { reason });

  // Nothing to drain — exit deterministically so Render doesn't SIGKILL us.
  if (!server?.listening) {
    process.exit(process.exitCode ?? 0);
  }

  const timer = setTimeout(() => {
    log('error', 'Graceful shutdown timed out; forcing process exit.');
    server.closeAllConnections?.();
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  // Do not let the timer itself keep the process alive if server.close()
  // finishes first and clears it.
  timer.unref();

  server.close((error) => {
    clearTimeout(timer);
    if (error) {
      log('error', 'HTTP server shutdown failed', { message: error.message });
      process.exit(1);
    }
    log('info', 'Graceful shutdown completed');
    // Exit explicitly. If process.exitCode was already 1 (e.g. server-error
    // path), preserve it; otherwise exit 0.
    process.exit(process.exitCode ?? 0);
  });
  // Ask undici/keep-alive clients to release their sockets so close() can finish.
  server.closeIdleConnections?.();
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

// Monitor uncaught exceptions without overriding Node's default fatal behavior.
// Node 15+ also re-emits unhandled promise rejections as uncaught exceptions
// in the default `--unhandled-rejections=throw` mode, so this single monitor
// covers both failure classes.
process.on('uncaughtExceptionMonitor', (error, origin) => {
  log('error', 'Uncaught exception; Node.js will terminate the process', {
    origin,
    message: error.message,
    stack: error.stack,
  });
});

start().catch((error) => {
  log('error', 'API startup failed', {
    code: error.code || 'STARTUP_ERROR',
    message: error.message,
    stack: error.stack,
  });
  // Exit explicitly. Relying on process.exitCode alone can hang if the
  // Supabase client (or another dependency) has open handles.
  process.exit(1);
});