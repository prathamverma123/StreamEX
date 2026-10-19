import cookieParser from 'cookie-parser';

/**
 * Re-export so app.ts imports stay single-line (cookie-parser is a runtime
 * dependency of app.ts and listed in package.json).
 */
export { cookieParser };
export default cookieParser;
