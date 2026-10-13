import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A static guard over the whole source tree.
 *
 * Phase 2 is read-only against the CRM: the caller's key is documented as
 * read-only, and no write workflow has been authorized. These tests fail if a
 * write ever creeps in, including by accident in a later edit.
 */

const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: path.replace(process.cwd(), '').replace(/\\/g, '/'),
  text: readFileSync(path, 'utf8'),
}));

describe('no CRM writes exist in the codebase', () => {
  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('issues no %s request', (verb) => {
    const offenders = files.filter(({ text }) =>
      new RegExp(`method:\\s*['"\`]${verb}['"\`]`, 'i').test(text),
    );

    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('references none of the documented write endpoints', () => {
    const writePaths = ['/status', '/assignment', '/notes', '/corrections'].map(
      (suffix) => `/api/crm/leads/\${leadId}${suffix}`,
    );

    for (const writePath of writePaths) {
      const offenders = files.filter(({ text }) => text.includes(writePath));
      expect(offenders.map((f) => f.path)).toEqual([]);
    }
  });

  it('never sends the agent headers that only writes require', () => {
    // X-Agent-Email / X-Agent-Name are required on every POST. Their absence is
    // structural proof that no write path exists.
    const offenders = files.filter(
      ({ text }) => /['"]X-Agent-Email['"]/i.test(text) || /['"]X-Agent-Name['"]/i.test(text),
    );

    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  // Matches an assignment of a literal value, e.g. `lead_status: 'Booked'`.
  // A Zod schema declaration (`lead_status: z.string()`) describes how we READ
  // the field, so it is correctly not flagged.
  const statusWrites: [string, RegExp][] = [
    ['lead_status', /lead_status\s*:\s*['"`]/],
    ['trip_status', /trip_status\s*:\s*['"`]/],
  ];

  it.each(statusWrites)('never assigns a %s value', (_field, pattern) => {
    const offenders = files.filter(({ text }) => pattern.test(text));

    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('contains no Retell or Calendly integration yet', () => {
    const offenders = files.filter(({ text }) =>
      /\b(retell|calendly)\.(com|io)|api\.retellai|RETELL_API_KEY|CALENDLY_API_TOKEN/i.test(text),
    );

    expect(offenders.map((f) => f.path)).toEqual([]);
  });
});

describe('no credentials are committed', () => {
  it('hardcodes no API key in source', () => {
    const offenders = files.filter(({ text }) =>
      /(['"])(sk_live_|sk_test_|key_live_)[A-Za-z0-9]{8,}\1/.test(text),
    );

    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('keeps the API key out of .env.example', () => {
    const example = readFileSync(join(process.cwd(), '.env.example'), 'utf8');
    const keyLine = example
      .split('\n')
      .find((line) => line.trim().startsWith('LEAD_API_KEY_CALLER='));

    // Present as a placeholder with no value, or commented out entirely.
    expect(keyLine === undefined || keyLine.trim() === 'LEAD_API_KEY_CALLER=').toBe(true);
  });

  it('keeps .env out of version control', () => {
    const gitignore = readFileSync(join(process.cwd(), '.gitignore'), 'utf8');

    expect(gitignore.split('\n').map((l) => l.trim())).toContain('.env');
  });
});
