import { test, describe, beforeEach, afterEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CookieJar } from 'tough-cookie';

// Hermetic state: a throwaway home, and a PATH with no `security` or
// `secret-tool` so the encryption key falls back to a keyfile in that home
// rather than touching the real OS keychain entry.
const home = mkdtempSync(join(tmpdir(), 'bbmcp-renew-'));
process.env.BLACKBOARD_MCP_HOME = home;
process.env.PATH = join(home, 'empty-bin');

const { refreshSession, idpSignInRequired } = await import('../dist/auth/saml.js');
const { Session } = await import('../dist/auth/session.js');
const { HttpClient } = await import('../dist/client/http.js');

const BB = 'https://bb.example.edu';
const IDP = 'login.idp.example';

after(() => rmSync(home, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A session shaped like a real SSO sign-in: Blackboard cookies plus the IdP's. */
async function makeSession(
  opts: {
    idpCookie?: boolean;
    pinIdp?: boolean;
    capturedAt?: Date;
    xsrf?: string;
    extraCookieHost?: string;
  } = {},
): Promise<InstanceType<typeof Session>> {
  const xsrf = opts.xsrf ?? 'OLD';
  const jar = new CookieJar();
  await jar.setCookie(`BbRouter=expires:1,id:1,xsrf:${xsrf}; Path=/; Secure`, `${BB}/`);
  if (opts.idpCookie !== false) {
    await jar.setCookie(
      `ESTSAUTHPERSISTENT=persistent; Domain=${IDP}; Path=/; Secure`,
      `https://${IDP}/`,
    );
  }
  if (opts.extraCookieHost) {
    await jar.setCookie(`tracker=1; Path=/; Secure`, `https://${opts.extraCookieHost}/`);
  }
  return new Session(
    BB,
    jar,
    xsrf,
    'test-agent',
    opts.capturedAt ?? new Date('2026-01-01T00:00:00Z'),
    undefined,
    opts.pinIdp === false ? [] : [IDP],
  );
}

type Route = (url: URL, init: RequestInit | undefined) => Response;
const realFetch = globalThis.fetch;
let calls: string[] = [];

function stubFetch(route: Route): void {
  calls = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.hostname}${url.pathname}${url.search}`);
    return route(url, init);
  }) as typeof fetch;
}

const redirect = (to: string, cookies: string[] = []): Response => {
  const h = new Headers({ location: to });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(null, { status: 302, headers: h });
};
const page = (html: string, cookies: string[] = []): Response => {
  const h = new Headers({ 'content-type': 'text/html' });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(html, { status: 200, headers: h });
};

const SIGN_IN_PAGE = `<html><script>//<![CDATA[
$Config={"sErrorCode":"50058","pgid":"ConvergedSignIn","hpgid":1104};
//]]></script></html>`;

beforeEach(() => {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
});

describe('Azure AD sign-in page detection', () => {
  test('recognises "no usable SSO session" (50058)', () => {
    assert.match(idpSignInRequired(SIGN_IN_PAGE) ?? '', /50058/);
  });

  test('recognises an expired provider session (50133)', () => {
    assert.ok(idpSignInRequired('$Config={"sErrorCode":"50133"}'));
  });

  test('ignores codes that are not a sign-in demand', () => {
    // 50140 is the "stay signed in?" interrupt, not a failure to authenticate.
    assert.equal(idpSignInRequired('$Config={"sErrorCode":"50140"}'), null);
  });

  test('returns null when the page carries no error code', () => {
    assert.equal(idpSignInRequired('<html><body>Working...</body></html>'), null);
    assert.equal(idpSignInRequired('$Config={"sErrorCode":""}'), null);
  });
});

describe('refreshSession and identity-provider cookies', () => {
  test('keeps the IdP cookies when the session was still valid', async () => {
    // Regression: a live session short-circuits at `GET /ultra -> 200` and never
    // visits the provider. Pruning "hosts outside the chain" then deleted every
    // provider cookie, so the *next* expiry had nothing to renew with.
    const session = await makeSession();
    stubFetch((url) =>
      url.pathname === '/ultra'
        ? page('<html>ultra</html>', ['BbRouter=expires:2,id:2,xsrf:NEW; Path=/; Secure'])
        : new Response('unexpected', { status: 500 }),
    );

    const result = await refreshSession(session);

    assert.equal(result.ok, true);
    assert.deepEqual(calls, ['GET bb.example.edu/ultra'], 'must not leave Blackboard');
    assert.equal(
      (await session.jar.getCookies(`https://${IDP}/`)).length,
      1,
      'provider cookie must survive',
    );
    assert.deepEqual(session.idpHosts, [IDP], 'pinned provider must survive');
    assert.equal(await session.canAutoRefresh(), true);
  });

  test('renews through the provider, rotates its cookies and prunes strays', async () => {
    const session = await makeSession({ extraCookieHost: 'ads.other.example' });
    let ultra = 0;
    stubFetch((url, init) => {
      if (url.hostname === 'bb.example.edu' && url.pathname === '/ultra') {
        ultra += 1;
        return ultra === 1
          ? redirect(`https://${IDP}/saml2?SAMLRequest=x`)
          : page('<html>ultra</html>');
      }
      if (url.hostname === IDP) {
        return page(
          `<body onload="document.forms[0].submit()">
             <form method="POST" action="${BB}/auth-saml/saml/SSO">
               <input type="hidden" name="SAMLResponse" value="r"></form></body>`,
          [`ESTSAUTHPERSISTENT=rotated; Domain=${IDP}; Path=/; Secure`],
        );
      }
      if (url.pathname === '/auth-saml/saml/SSO' && init?.method === 'POST') {
        return redirect('/ultra', ['BbRouter=expires:2,id:2,xsrf:NEW; Path=/; Secure']);
      }
      return new Response('unexpected', { status: 500 });
    });

    const result = await refreshSession(session);

    assert.equal(result.ok, true);
    assert.equal(session.xsrfToken, 'NEW');
    assert.deepEqual(session.idpHosts, [IDP]);
    const idp = await session.jar.getCookies(`https://${IDP}/`);
    assert.equal(idp[0]?.value, 'rotated', 'the provider rotated its cookie; keep the new one');
    assert.equal(
      (await session.jar.getCookies('https://ads.other.example/')).length,
      0,
      'an unrelated host outside the chain is dropped',
    );
  });

  test('reports a missing provider session without walking to the provider', async () => {
    const session = await makeSession({ idpCookie: false });
    stubFetch((url) =>
      url.pathname === '/ultra' ? redirect(`https://${IDP}/saml2`) : new Response('x', { status: 500 }),
    );

    const result = await refreshSession(session);

    assert.equal(result.ok, false);
    assert.equal(result.needsInteractiveLogin, true);
    assert.match(result.reason ?? '', /no cookies are stored for login\.idp\.example/);
    assert.ok(!calls.some((c) => c.includes(IDP)), 'no request should reach the provider');
  });

  test('classifies the provider sign-in page as needing a real login', async () => {
    // Regression: this page has no form or inputs, so it used to read as
    // "stalled" (retryable) instead of "sign in again".
    const session = await makeSession();
    stubFetch((url) =>
      url.pathname === '/ultra' ? redirect(`https://${IDP}/saml2`) : page(SIGN_IN_PAGE),
    );
    const routerBefore = (await session.jar.getCookies(BB)).find((c) => c.key === 'BbRouter')?.value;

    const result = await refreshSession(session);

    assert.equal(result.ok, false);
    assert.equal(result.needsInteractiveLogin, true);
    assert.match(result.reason ?? '', /50058/);
    const routerAfter = (await session.jar.getCookies(BB)).find((c) => c.key === 'BbRouter')?.value;
    assert.equal(routerAfter, routerBefore, 'a failed renewal must not disturb the session');
  });
});

describe('stored session sharing between processes', () => {
  test('a long-running process adopts a newer sign-in', async () => {
    const server = await makeSession({ xsrf: 'OLD', capturedAt: new Date('2026-01-01T00:00:00Z') });
    await server.persist();
    const loaded = await Session.load();

    await sleep(20);
    // `auth login` in another terminal.
    const login = await makeSession({ xsrf: 'FRESH', capturedAt: new Date('2026-01-02T00:00:00Z') });
    await login.persist();

    assert.equal(await loaded.adoptIfNewer(), true);
    assert.equal(loaded.xsrfToken, 'FRESH');
    assert.equal(loaded.capturedAt.toISOString(), '2026-01-02T00:00:00.000Z');
    assert.equal(await loaded.adoptIfNewer(), false, 'nothing newer the second time');
  });

  test('a stale process does not overwrite a newer sign-in', async () => {
    const first = await makeSession({ xsrf: 'OLD', capturedAt: new Date('2026-01-01T00:00:00Z') });
    await first.persist();
    const stale = await Session.load();

    await sleep(20);
    const login = await makeSession({ xsrf: 'FRESH', capturedAt: new Date('2026-01-02T00:00:00Z') });
    await login.persist();

    // The stale server absorbs a Set-Cookie and persists, as it does constantly.
    await stale.persist();

    const onDisk = await Session.load();
    assert.equal(onDisk.xsrfToken, 'FRESH', 'the fresh login must still be what is stored');
  });

  test('writes are atomic and leave no temp files behind', async () => {
    await (await makeSession()).persist();
    const files = readdirSync(home);
    assert.ok(files.includes('session.enc'));
    assert.deepEqual(files.filter((f) => f.endsWith('.tmp')), []);
  });
});

describe('auto-refresh capability', () => {
  test('a pinned provider with no cookies is not "enabled"', async () => {
    // `idpHosts` records which provider the tenant uses; it can outlive the
    // cookies, and reporting it as enabled hides the problem until expiry.
    assert.equal(await (await makeSession({ idpCookie: false })).canAutoRefresh(), false);
    assert.equal(await (await makeSession({ pinIdp: false })).canAutoRefresh(), false);
    assert.equal(await (await makeSession()).canAutoRefresh(), true);
  });
});

describe('HttpClient renewal resilience', () => {
  const config = {
    baseUrl: BB,
    pageSize: 50,
    maxDownloadBytes: 1024 * 1024,
    allowWrites: false,
    extraHosts: [],
  };

  test('a failed renewal never disables renewal for good', async () => {
    // Regression: three failures set a flag that was never cleared, so a laptop
    // waking before Wi-Fi was back stopped renewing until the server restarted.
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const session = await makeSession();
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    const http = new HttpClient(session, config);

    assert.equal(await http.tryRefresh(), false);
    assert.equal(calls.length, 1);

    assert.equal(await http.tryRefresh(), false);
    assert.equal(calls.length, 1, 'inside the cooldown it must not hammer the provider');

    // Backoff grows (30s, 1m, 2m) but never becomes "never".
    for (const wait of [31_000, 61_000, 121_000, 241_000]) {
      mock.timers.tick(wait);
      await http.tryRefresh();
    }
    assert.equal(calls.length, 5, 'every backoff window must allow another attempt');
  });

  test('a re-login is picked up even while renewal is cooling down', async () => {
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const session = await makeSession({ idpCookie: false });
    await session.persist();
    stubFetch((url) =>
      url.pathname === '/ultra' ? redirect(`https://${IDP}/saml2`) : new Response('x', { status: 500 }),
    );
    const http = new HttpClient(session, config);

    assert.equal(await http.tryRefresh(), false, 'provider session is gone');

    // The user runs `auth login` in a terminal.
    await sleep(20);
    const login = await makeSession({ xsrf: 'FRESH', capturedAt: new Date('2026-06-01T00:00:00Z') });
    await login.persist();

    assert.equal(await http.tryRefresh(), true, 'no restart needed, no waiting out the cooldown');
    assert.equal(session.xsrfToken, 'FRESH');
  });
});
