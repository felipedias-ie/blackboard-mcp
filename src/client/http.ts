import { Session } from '../auth/session.js';
import { refreshSession } from '../auth/saml.js';
import type { Config } from '../config.js';
import { BlackboardError, sessionExpired, toBlackboardError } from '../lib/errors.js';
import { log } from '../lib/logger.js';

export interface RequestOptions {
  method?: string;
  /** Path relative to the instance origin, or an absolute URL on an allowed host. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Overrides the JSON default; used for form posts and file uploads. */
  headers?: Record<string, string>;
  /** Abort the request after this many ms. */
  timeoutMs?: number;
  /** Number of retry attempts for transient failures. */
  retries?: number;
  /** Suppress the automatic throw on 404, returning the response instead. */
  allowNotFound?: boolean;
  /**
   * Permits a non-GET request even when writes are disabled.
   *
   * Blackboard exposes two read operations behind non-GET verbs. The
   * `utilities/batch` fan-out (PUT) and the activity stream (POST). So those
   * must not be caught by the read-only guard.
   */
  forceAllowWrite?: boolean;
  /** Internal: set false on the post-renewal retry to prevent a refresh loop. */
  allowRefresh?: boolean;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  url: string;
  body: Response;
}

/** `BodyInit` is not in scope without lib.dom, so derive it from `fetch`. */
type FetchBody = NonNullable<Parameters<typeof fetch>[1]>['body'];

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;

/** Paths that mean "you are not signed in", whatever status code came with them. */
const LOGIN_PATH_MARKERS = [
  '/webapps/login',
  '/auth-saml/saml/login',
  '/adfs/ls',
  '/login.jsp',
  '/oidcAuth',
];

export class HttpClient {
  /** Serialises requests lightly so we never hammer the tenant. */
  private inFlight = 0;
  private readonly maxConcurrent = 4;
  private minIntervalMs = 120;
  private lastStart = 0;

  /**
   * De-duplicates concurrent renewal attempts.
   *
   * When a session lapses, every in-flight request fails at once. Without this
   * they would each start their own SSO replay, stampeding the identity
   * provider and racing to overwrite the stored session.
   */
  private refreshing: Promise<boolean> | null = null;
  /** Consecutive failed renewals; drives the backoff. */
  private refreshFailures = 0;
  /** Earliest time another renewal may be attempted. */
  private nextRefreshAt = 0;

  constructor(
    readonly session: Session,
    readonly config: Config,
  ) {}

  /**
   * Renews the session silently.
   *
   * Returns false when renewal did not happen, so callers surface the original
   * SESSION_EXPIRED with its instruction to re-run `auth login`.
   *
   * Failure never disables renewal for good. This client lives as long as the
   * MCP server, which runs for days across laptop sleeps and network changes,
   * so a counter that gave up after a few failures turned one bad moment (Wi-Fi
   * not yet back after wake) into "never renews again until restarted". Failures
   * back off instead, and every attempt first checks whether the user has signed
   * in again in the meantime.
   */
  async tryRefresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;

    this.refreshing = this.renew();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  private async renew(): Promise<boolean> {
    // A fresh `auth login` (or a sibling process's renewal) already fixed it.
    if (await this.session.adoptIfNewer()) {
      this.refreshFailures = 0;
      this.nextRefreshAt = 0;
      return true;
    }

    if (Date.now() < this.nextRefreshAt) return false;

    const result = await refreshSession(this.session);
    if (result.ok) {
      this.refreshFailures = 0;
      this.nextRefreshAt = 0;
      return true;
    }

    this.refreshFailures += 1;
    log.warn(`Silent session renewal failed: ${result.reason ?? 'unknown'}`);
    // A provider demanding credentials will keep demanding them, so there is no
    // point re-walking its chain every few seconds. Wait a couple of minutes
    // (the stored-session check above still catches a re-login immediately).
    // Anything else is probably transient: back off 30s, 1m, 2m ... capped.
    const delay = result.needsInteractiveLogin
      ? 2 * 60_000
      : Math.min(30_000 * 2 ** (this.refreshFailures - 1), 10 * 60_000);
    this.nextRefreshAt = Date.now() + delay;
    return false;
  }

  private allowedHost(host: string): boolean {
    const base = new URL(this.session.baseUrl).hostname;
    if (host === base) return true;
    // SaaS tenants serve attachments from sibling hosts and CloudFront.
    if (host.endsWith('.blackboard.com')) return true;
    if (host.endsWith('.bbcdn.io')) return true;
    if (host.endsWith('.cloudfront.net')) return true;
    return this.config.extraHosts.includes(host);
  }

  resolve(path: string, query?: RequestOptions['query']): URL {
    const url = /^https?:\/\//i.test(path)
      ? new URL(path)
      : new URL(path.startsWith('/') ? path : `/${path}`, this.session.baseUrl);
    if (!this.allowedHost(url.hostname)) {
      throw new BlackboardError('BAD_INPUT', `Refusing to send session cookies to ${url.hostname}.`, {
        hint: `Only ${new URL(this.session.baseUrl).hostname} and known Blackboard file hosts are allowed. Add the host to "extraHosts" in your config if it is legitimate.`,
      });
    }
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url;
  }

  /** Applies a concurrency cap and a minimum inter-request gap. */
  private async throttle<T>(fn: () => Promise<T>): Promise<T> {
    while (this.inFlight >= this.maxConcurrent) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const gap = this.minIntervalMs - (Date.now() - this.lastStart);
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    this.inFlight += 1;
    this.lastStart = Date.now();
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
    }
  }

  async request(opts: RequestOptions): Promise<RawResponse> {
    const retries = opts.retries ?? DEFAULT_RETRIES;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) {
        const backoff = Math.min(2 ** attempt * 400, 5_000) + Math.random() * 200;
        log.debug(`Retrying ${opts.path} in ${Math.round(backoff)}ms`, { attempt });
        await new Promise((r) => setTimeout(r, backoff));
      }
      try {
        return await this.throttle(() => this.attempt(opts));
      } catch (err) {
        lastError = err;
        const be = toBlackboardError(err);

        // An expired session is recoverable without the user: replay the
        // institution's SSO chain, then retry the request once.
        if (be.code === 'SESSION_EXPIRED' && opts.allowRefresh !== false) {
          if (await this.tryRefresh()) {
            log.info(`Session renewed; retrying ${opts.path}`);
            return await this.throttle(() => this.attempt({ ...opts, allowRefresh: false }));
          }
          throw be;
        }

        // Other auth failures and client errors will not fix themselves.
        if (!['RATE_LIMITED', 'UPSTREAM', 'NETWORK'].includes(be.code)) throw be;
      }
    }
    throw toBlackboardError(lastError);
  }

  private async attempt(opts: RequestOptions): Promise<RawResponse> {
    const url = this.resolve(opts.path, opts.query);
    const method = (opts.method ?? 'GET').toUpperCase();

    if (method !== 'GET' && method !== 'HEAD' && !this.config.allowWrites && !opts.forceAllowWrite) {
      throw new BlackboardError('FORBIDDEN', `Write requests are disabled (${method} ${url.pathname}).`, {
        hint: 'This server is read-only by default. Set BLACKBOARD_MCP_ALLOW_WRITES=1 to permit writes.',
      });
    }

    const headers: Record<string, string> = {
      'User-Agent': this.session.userAgent,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: await this.session.cookieHeader(url.toString()),
      ...opts.headers,
    };

    // Blackboard's Ultra API rejects non-GET requests that lack the echoed
    // CSRF token or an same-origin Origin header.
    if (method !== 'GET' && method !== 'HEAD') {
      if (this.session.xsrfToken) headers['X-Blackboard-XSRF'] = this.session.xsrfToken;
      headers.Origin ??= this.session.baseUrl;
      headers.Referer ??= `${this.session.baseUrl}/ultra`;
    }

    let payload: FetchBody;
    if (opts.body !== undefined) {
      if (typeof opts.body === 'string' || opts.body instanceof Uint8Array) {
        payload = opts.body as FetchBody;
      } else if (opts.body instanceof FormData || opts.body instanceof URLSearchParams) {
        payload = opts.body;
      } else {
        payload = JSON.stringify(opts.body);
        headers['Content-Type'] ??= 'application/json';
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: payload,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new BlackboardError('NETWORK', `Request to ${url.pathname} timed out.`, {
          hint: 'The tenant may be slow or unreachable. Try again, or raise timeoutMs.',
          cause: err,
        });
      }
      throw toBlackboardError(err);
    } finally {
      clearTimeout(timer);
    }

    await this.absorbCookies(res, url.toString());

    // Manual redirect handling so we can re-authorise cookies per hop and
    // notice when we are being bounced to an SSO login page.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location) {
        const next = new URL(location, url);
        if (this.looksLikeLogin(next.pathname + next.search)) throw sessionExpired();
        if ((opts.retries ?? DEFAULT_RETRIES) >= 0) {
          return this.attempt({
            ...opts,
            path: next.toString(),
            // A 303/302 after a POST becomes a GET, per fetch semantics.
            method: res.status === 303 || res.status === 302 ? 'GET' : method,
            body: res.status === 303 || res.status === 302 ? undefined : opts.body,
            retries: 0,
          });
        }
      }
    }

    if (this.looksLikeLogin(new URL(res.url || url).pathname)) throw sessionExpired();

    if (res.status === 401 || res.status === 403) {
      // Blackboard uses 403 both for "expired" and for genuine permission gaps.
      const text = await res.clone().text().catch(() => '');
      if (/session|login|authenticat/i.test(text) || res.status === 401) throw sessionExpired();
      throw new BlackboardError('FORBIDDEN', `Access denied for ${url.pathname}.`, {
        status: res.status,
        hint: 'Your account may not have permission for this course or resource.',
        detail: text.slice(0, 400),
      });
    }

    if (res.status === 404) {
      if (opts.allowNotFound) return { status: 404, headers: res.headers, url: res.url, body: res };
      throw new BlackboardError('NOT_FOUND', `Not found: ${url.pathname}`, { status: 404 });
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '0');
      if (retryAfter > 0) this.minIntervalMs = Math.min(retryAfter * 1000, 5_000);
      throw new BlackboardError('RATE_LIMITED', 'Blackboard is rate limiting this session.', {
        status: 429,
        hint: 'Requests are being retried with backoff. Reduce concurrent tool calls if this persists.',
      });
    }

    if (res.status >= 500) {
      throw new BlackboardError('UPSTREAM', `Blackboard returned ${res.status} for ${url.pathname}.`, {
        status: res.status,
      });
    }

    if (!res.ok) {
      const text = await res.clone().text().catch(() => '');
      throw new BlackboardError('UPSTREAM', `Unexpected ${res.status} for ${url.pathname}.`, {
        status: res.status,
        detail: text.slice(0, 400),
      });
    }

    return { status: res.status, headers: res.headers, url: res.url || url.toString(), body: res };
  }

  private looksLikeLogin(pathAndQuery: string): boolean {
    return LOGIN_PATH_MARKERS.some((m) => pathAndQuery.startsWith(m) || pathAndQuery.includes(m));
  }

  /** Keeps the jar current so rotating session cookies survive across calls. */
  private async absorbCookies(res: Response, url: string): Promise<void> {
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies.length === 0) return;
    for (const raw of setCookies) {
      await this.session.jar.setCookie(raw, url, { ignoreError: true });
    }
    await this.session.persist();
  }

  async json<T>(opts: RequestOptions): Promise<T> {
    const res = await this.request(opts);
    const text = await res.body.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // An HTML body where JSON was expected almost always means a login wall.
      if (/<html/i.test(text)) throw sessionExpired();
      throw new BlackboardError('UPSTREAM', `Expected JSON from ${opts.path}, got something else.`, {
        detail: text.slice(0, 300),
      });
    }
  }

  async text(opts: RequestOptions): Promise<string> {
    const res = await this.request(opts);
    return res.body.text();
  }

  async bytes(opts: RequestOptions): Promise<{ data: Buffer; headers: Headers; url: string }> {
    const res = await this.request(opts);
    const buf = Buffer.from(await res.body.arrayBuffer());
    return { data: buf, headers: res.headers, url: res.url };
  }
}
