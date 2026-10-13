// Deterministic configuration for every test run. Set before any module that
// reads `process.env` at import time (config, logger, Prisma client).
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/ai_caller_test?schema=public';
process.env.CORS_ALLOWED_ORIGINS ??= '';
