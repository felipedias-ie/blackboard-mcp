import { CookieJar, Cookie } from 'tough-cookie';
import { z } from 'zod';
import { readSecret, writeSecret, purgeSecret, storedMtimeMs } from './store.js';
import { notAuthenticated, BlackboardError } from '../lib/errors.js';
import { log, redact } from '../lib/logger.js';

/**
 * Cookies Blackboard Learn actually relies on. We keep the whole jar, but these
 * are the names we assert on when deciding whether a capture looks usable.
 *
 *  - JSESSIONID   classic Learn servlet session (both Original and Ultra)
 *  - BbRouter      Ultra/SaaS routing + auth envelope; the important one on SaaS
 *  - AWSELB*       load-balancer stickiness on some SaaS tenants
 *  - xsrf          double-submit CSRF token, mirrored into a request header
 */
export const REQUIRED_COOKIE_CANDIDATES = ['BbRouter', 'JSESSIONID'] as const;

export const StoredSessionSchema = z.object({
  version: z.literal(1),
  baseUrl: z.string().url(),
  /** Serialised tough-cookie jar. */
  jar: z.unknown(),
  /** Value mirrored into the X-Blackboard-XSRF header, when the tenant uses one. */
  xsrfToken: z.string().optional(),
  /** User-Agent captured alongside the cookies; reused so fingerprints match. */
  userAgent: z.string().optional(),
  capturedAt: z.string(),
  /**
   * Identity-provider hosts seen in Blackboard's own SSO redirect chain.
   * Pinned so silent refresh knows where it is allowed to send cookies.
   */
  idpHosts: z.array(z.string()).optional(),
  /** Cached identity so `whoami` does not need a round trip. */
  user: z
    .object({
      id: z.string().optional(),
      userName: z.string().optional(),
      displayName: z.string().optional(),
    })
    .optional(),
});

export type StoredSession = z.infer<typeof StoredSessionSchema>;

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export class Session {
  constructor(
    readonly baseUrl: string,
    /** Mutated wholesale by a successful silent refresh. */
    public jar: CookieJar,
    public xsrfToken: string | undefined,
    readonly userAgent: string,
    public capturedAt: Date,
    public user: StoredSession['user'],
    /** IdP hosts this session is permitted to re-authenticate through. */
    public idpHosts: string[] = [],
  ) {}

  /**
   * Modified-time of the stored file as of our last read or write. A newer one
   * means another process (a fresh `auth login`, a sibling's renewal) wrote it.
   */
  private storedMtimeMs = 0;

  static async load(): Promise<Session> {
    // Stat before reading: a write landing in between then looks newer than we
    // hold, and is re-checked, rather than being silently skipped.
    const mtime = storedMtimeMs();
    const raw = await readSecret<unknown>();
    if (!raw) throw notAuthenticated();
    const parsed = StoredSessionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BlackboardError('NOT_AUTHENTICATED', 'Stored session has an unrecognised shape.', {
        hint: 'Run `blackboard-mcp auth logout --purge`, then sign in again.',
        detail: parsed.error.flatten(),
      });
    }
    const s = parsed.data;
    const jar = await CookieJar.deserialize(s.jar as never);
    const session = new Session(
      s.baseUrl,
      jar,
      s.xsrfToken,
      s.userAgent ?? DEFAULT_USER_AGENT,
      new Date(s.capturedAt),
      s.user,
      s.idpHosts ?? [],
    );
    session.storedMtimeMs = mtime;
    return session;
  }

  static async tryLoad(): Promise<Session | null> {
    try {
      return await Session.load();
    } catch (err) {
      if (err instanceof BlackboardError && err.code === 'NOT_AUTHENTICATED') return null;
      throw err;
    }
  }

  /**
   * Builds a session from raw `Cookie:` header text, as copied from devtools.
   *
   * Only carries cookies for the Blackboard host, so a session built this way
   * cannot be silently refreshed. See `Session.fromBrowserCookies` for the
   * multi-host path that can.
   */
  static async fromCookieHeader(
    baseUrl: string,
    header: string,
    opts: { userAgent?: string } = {},
  ): Promise<Session> {
    const jar = new CookieJar();
    const pairs = header
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean);
    if (pairs.length === 0) {
      throw new BlackboardError('BAD_INPUT', 'Cookie header was empty.', {
        hint: 'Paste the full value of the `Cookie:` request header from a signed-in Blackboard request.',
      });
    }
    const host = new URL(baseUrl).hostname;
    for (const pair of pairs) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const cookie = new Cookie({ key: name, value, domain: host, path: '/', secure: true });
      await jar.setCookie(cookie, baseUrl, { ignoreError: true });
    }
    const session = new Session(
      baseUrl,
      jar,
      await extractXsrf(jar, baseUrl),
      opts.userAgent ?? DEFAULT_USER_AGENT,
      new Date(),
      undefined,
    );
    await session.assertLooksUsable();
    return session;
  }


  /**
   * Builds a session from cookies read out of a real browser profile.
   *
   * Unlike `fromCookieHeader`, this keeps cookies for *every* host supplied -
   * critically the identity provider's: which is what makes silent refresh
   * possible later. Session cookies (no expiry) are kept too: Blackboard's
   * BbRouter is one.
   */
  static async fromBrowserCookies(
    baseUrl: string,
    cookies: Array<{
      host: string;
      name: string;
      value: string;
      path: string;
      secure: boolean;
      httpOnly: boolean;
      expires: number;
    }>,
    opts: { userAgent?: string } = {},
  ): Promise<Session> {
    const jar = new CookieJar();
    const idpHosts = new Set<string>();
    const baseHost = new URL(baseUrl).hostname;

    for (const c of cookies) {
      if (!c.name || !c.value) continue;
      const domain = c.host.replace(/^\./, '');
      const hostOnly = !c.host.startsWith('.');
      // An already-expired cookie is dead weight and can confuse the jar.
      if (c.expires > 0 && c.expires < Date.now()) continue;

      const cookie = new Cookie({
        key: c.name,
        value: c.value,
        domain,
        path: c.path || '/',
        secure: c.secure,
        httpOnly: c.httpOnly,
        hostOnly,
        expires: c.expires > 0 ? new Date(c.expires) : 'Infinity',
      });
      await jar.setCookie(cookie, `https://${domain}${c.path || '/'}`, {
        ignoreError: true,
        http: true,
      });
      if (domain !== baseHost && !baseHost.endsWith(`.${domain}`)) idpHosts.add(domain);
    }

    const session = new Session(
      baseUrl,
      jar,
      await extractXsrf(jar, baseUrl),
      opts.userAgent ?? DEFAULT_USER_AGENT,
      new Date(),
      undefined,
      [...idpHosts],
    );
    await session.assertLooksUsable();
    return session;
  }

  async cookieHeader(url: string): Promise<string> {
    return this.jar.getCookieString(url);
  }

  async cookieNames(): Promise<string[]> {
    const cookies = await this.jar.getCookies(this.baseUrl);
    return cookies.map((c) => c.key);
  }

  /**
   * Cheap structural check before we spend a network round trip: does the jar
   * contain at least one cookie Blackboard uses to carry authentication?
   */
  async assertLooksUsable(): Promise<void> {
    const names = await this.cookieNames();
    const hasAuthCookie = REQUIRED_COOKIE_CANDIDATES.some((n) => names.includes(n));
    if (!hasAuthCookie) {
      throw new BlackboardError('BAD_INPUT', 'No Blackboard auth cookie found in the capture.', {
        hint: `Expected one of ${REQUIRED_COOKIE_CANDIDATES.join(' or ')}. Found: ${names.join(', ') || '(none)'}. Make sure you copied the cookies from a request to ${this.baseUrl} while signed in.`,
      });
    }
    log.debug('Session cookies', { names, xsrf: this.xsrfToken ? redact(this.xsrfToken) : null });
  }

  /**
   * True when this session holds cookies for the identity provider(s) it is
   * pinned to, which is what silent renewal needs.
   *
   * `idpHosts` alone is not proof: it records which provider the tenant uses,
   * and can outlive the cookies that make it usable.
   */
  async canAutoRefresh(): Promise<boolean> {
    if (this.idpHosts.length === 0) return false;
    for (const host of this.idpHosts) {
      if ((await this.jar.getCookies(`https://${host}/`)).length > 0) return true;
    }
    return false;
  }

  /**
   * Switches to the stored session when another process has written a newer
   * one, and returns whether it did.
   *
   * The MCP server is long-lived and loads its session once. Without this, a
   * user who re-runs `auth login` fixes the file on disk while the server keeps
   * using (and re-persisting) the dead one it started with.
   */
  async adoptIfNewer(): Promise<boolean> {
    const mtime = storedMtimeMs();
    if (mtime <= this.storedMtimeMs) return false;

    let fresh: Session | null;
    try {
      fresh = await Session.tryLoad();
    } catch (err) {
      log.debug('Could not re-read the stored session', (err as Error).message);
      return false;
    }
    this.storedMtimeMs = mtime;
    if (!fresh || fresh.baseUrl !== this.baseUrl) return false;
    if (fresh.capturedAt.getTime() <= this.capturedAt.getTime()) return false;

    this.jar = fresh.jar;
    this.xsrfToken = fresh.xsrfToken;
    this.capturedAt = fresh.capturedAt;
    this.user = fresh.user ?? this.user;
    this.idpHosts = fresh.idpHosts;
    log.info('Picked up a newer stored session', { capturedAt: fresh.capturedAt.toISOString() });
    return true;
  }

  async persist(): Promise<void> {
    // Never overwrite a newer sign-in made elsewhere with what we hold. This
    // process may have been running since before the user signed in again.
    if (await this.adoptIfNewer()) return;

    const payload: StoredSession = {
      version: 1,
      baseUrl: this.baseUrl,
      jar: await this.jar.serialize(),
      xsrfToken: this.xsrfToken,
      userAgent: this.userAgent,
      capturedAt: this.capturedAt.toISOString(),
      user: this.user,
      idpHosts: this.idpHosts,
    };
    await writeSecret(payload);
    this.storedMtimeMs = storedMtimeMs();
  }

  get ageHours(): number {
    return (Date.now() - this.capturedAt.getTime()) / 3_600_000;
  }
}

/**
 * Blackboard's Ultra front end reads the `xsrf` value out of the BbRouter
 * cookie payload and echoes it back as a header on mutating requests.
 * BbRouter looks like: `expires:...,id:...,signature:...,xsrf:<token>,...`
 */
export async function extractXsrf(jar: CookieJar, baseUrl: string): Promise<string | undefined> {
  const cookies = await jar.getCookies(baseUrl);
  const direct = cookies.find((c) => c.key.toLowerCase() === 'xsrf');
  if (direct) return direct.value;
  const router = cookies.find((c) => c.key === 'BbRouter');
  if (!router) return undefined;
  // Some tenants emit BbRouter values that contain a raw '%'
  // character which is not valid percent-encoding, so decodeURIComponent would
  // throw and abort the whole browser import. Fall back to the raw value.
  let decoded = router.value;
  try {
    decoded = decodeURIComponent(router.value);
  } catch {
    /* not percent-encoded; use as-is */
  }
  const match = /(?:^|,)xsrf:([^,]+)/.exec(decoded);
  return match?.[1];
}

export async function logout(purge: boolean): Promise<void> {
  await purgeSecret(purge);
}
