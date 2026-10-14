import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A static guard over the whole source tree.
 *
 * The invariant this protects is **"no CRM writes, and the only outbound write
 * verb anywhere is the one authorised Retell call-initiation endpoint."**
 *
 * It was deliberately narrowed (Phase 3) from the earlier "no Retell at all":
 * the Retell outbound client now legitimately issues a `POST` to
 * `/v2/create-phone-call`. Everything that made this a *CRM-write* guarantee is
 * kept exactly as strict - Lead API stays GET-only, no CRM write endpoints or
 * agent headers, no status writes, and Calendly stays entirely absent.
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

/** The single file permitted to issue an outbound write verb. */
const RETELL_CLIENT = '/src/integrations/retell/client.ts';

describe('no CRM writes exist in the codebase', () => {
  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('issues no PUT, PATCH or DELETE request anywhere', () => {
    const offenders = files.filter(({ text }) =>
      /method:\s*['"`](PUT|PATCH|DELETE)['"`]/i.test(text),
    );

    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('issues a POST only from the authorised Retell call-initiation client', () => {
    const offenders = files.filter(({ text }) => /method:\s*['"`]POST['"`]/i.test(text));

    // The Retell client may POST; nothing else may.
    expect(offenders.map((f) => f.path)).toEqual([RETELL_CLIENT]);
  });

  it('keeps the Lead API client strictly GET-only', () => {
    const leadApiWrites = files.filter(
      ({ path, text }) =>
        path.includes('/integrations/leadApi/') &&
        /method:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/i.test(text),
    );

    expect(leadApiWrites.map((f) => f.path)).toEqual([]);
  });

  it('points the Retell client only at the verified create-call endpoint, never the CRM', () => {
    const retell = files.find((f) => f.path === RETELL_CLIENT);
    expect(retell).toBeDefined();
    expect(retell!.text).toContain('/v2/create-phone-call');
    expect(retell!.text).not.toContain('/api/crm/');
  });

  it('references none of the documented CRM write endpoints', () => {
    const writePaths = ['/status', '/assignment', '/notes', '/corrections'].map(
      (suffix) => `/api/crm/leads/\${leadId}${suffix}`,
    );

    for (const writePath of writePaths) {
      const offenders = files.filter(({ text }) => text.includes(writePath));
      expect(offenders.map((f) => f.path)).toEqual([]);
    }
  });

  it('never sends the agent headers that only CRM writes require', () => {
    // X-Agent-Email / X-Agent-Name are required on every CRM POST. Their absence
    // is structural proof that no CRM write path exists.
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

  it('contains no Calendly integration yet', () => {
    const offenders = files.filter(({ text }) =>
      /\bcalendly\.(com|io)|CALENDLY_API_TOKEN/i.test(text),
    );

    expect(offenders.map((f) => f.path)).toEqual([]);
  });
});

describe('no credentials are committed', () => {
  it('hardcodes no API key in source', () => {
    const offenders = files.filter(({ text }) =>
      /(['"])(sk_live_|sk_test_|key_live_|key_[a-f0-9]{24})\1/.test(text),
    );

    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('keeps secret values out of .env.example (placeholders only)', () => {
    const example = readFileSync(join(process.cwd(), '.env.example'), 'utf8');
    const secretVars = ['LEAD_API_KEY_CALLER', 'RETELL_API_KEY'];

    for (const name of secretVars) {
      const line = example.split('\n').find((l) => l.trim().startsWith(`${name}=`));
      // Present as an empty placeholder, or commented out entirely.
      expect(line === undefined || line.trim() === `${name}=`).toBe(true);
    }
  });

  it('keeps .env out of version control', () => {
    const gitignore = readFileSync(join(process.cwd(), '.gitignore'), 'utf8');

    expect(gitignore.split('\n').map((l) => l.trim())).toContain('.env');
  });
});
