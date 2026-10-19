import type { Request, RequestHandler, Response, NextFunction } from 'express';

/** Require the authenticated user to be an admin. */
export function requireAdmin(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }
    if (req.user.role !== 'ADMIN') {
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Admin role required' },
      });
      return;
    }
    next();
  };
}
