import helmet from 'helmet';
import type { RequestHandler } from 'express';

/**
 * Security Headers (Issue #274)
 *
 * Helmet provides HSTS, X-Frame-Options, X-Content-Type-Options, and more.
 * Mounted once, globally, in `createApp` ahead of every router so that REST,
 * GraphQL, billing, status, health/metrics, docs, error and 404 responses all
 * carry the same headers. Regression tests: tests/security-headers.test.ts.
 */
export function securityHeaders(): RequestHandler {
  return helmet({
    // Content-Security-Policy: restrict resource origins, block inline execution
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'none'"],
        frameSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
    // HTTP Strict Transport Security: 1 year, include subdomains
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    // Prevents MIME-type sniffing
    noSniff: true,
    // Denies framing — defence against clickjacking
    frameguard: { action: 'deny' },
    // Referrer policy: only send origin on same-origin requests
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // Remove X-Powered-By
    hidePoweredBy: true,
    // XSS filter (legacy browsers)
    xssFilter: true,
    // Prevent IE from opening downloads in-site
    ieNoOpen: true,
  });
}
