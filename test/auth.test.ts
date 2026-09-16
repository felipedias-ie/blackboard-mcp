import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CookieJar, Cookie } from 'tough-cookie';

import { parseAutoSubmitForm, discoverIdpHosts } from '../dist/auth/saml.js';
import { chromeTimeToMs, toCookieHeader, isInfrastructureHost, kwalletFolder } from '../dist/auth/browsers.js';
import { extractXsrf } from '../dist/auth/session.js';
import { displayName } from '../dist/client/index.js';

describe('SSO handoff form parsing', () => {
  // Shape taken from a real Azure AD response captured mid-reload.
  const azure = `<html><head><title>Working...</title></head>
    <body onload="document.forms[0].submit()">
      <form method="POST" name="hiddenform" action="https://blackboard.example.edu/auth-saml/saml/SSO">
        <input type="hidden" name="SAMLResponse" value="PHNhbWxwOlJlc3BvbnNlIElEPSJfYzIx" />
        <input type="hidden" name="RelayState" value="abc&amp;def" />
        <noscript><input type="submit" value="Submit" /></noscript>
      </form>
    </body></html>`;

  test('extracts the action and hidden fields', () => {
    const form = parseAutoSubmitForm(azure, 'https://login.microsoftonline.com/x/saml2');
    assert.ok(form, 'form should be recognised');
    assert.equal(form.action, 'https://blackboard.example.edu/auth-saml/saml/SSO');
    assert.equal(form.method, 'POST');
    assert.equal(form.fields.get('SAMLResponse'), 'PHNhbWxwOlJlc3BvbnNlIElEPSJfYzIx');
  });

  test('decodes HTML entities in field values', () => {
    // RelayState routinely contains &amp;; posting it raw breaks the handoff.
    const form = parseAutoSubmitForm(azure, 'https://idp.example/x');
    assert.equal(form?.fields.get('RelayState'), 'abc&def');
  });

  test('decodes HTML entities in the form action', () => {
    // Some identity providers emit the action as character references. Posting the raw
    // string sends the handoff to a mangled URL and loops forever.
    const html = `<body onload="document.forms[0].submit()">
      <form method="POST" action="https&#x3a;&#x2f;&#x2f;login.example.edu&#x2f;samlsso">
        <input type="hidden" name="SAMLRequest" value="abc"></form></body>`;
    const form = parseAutoSubmitForm(html, 'https://blackboard.example.edu/auth-saml/saml/login');
    assert.equal(form?.action, 'https://login.example.edu/samlsso');
  });

  test('decodes numeric entities before named ones', () => {
    // `&amp;#x2f;` must stay the literal text `&#x2f;`, not become `/`.
    const html = `<body onload="document.forms[0].submit()">
      <form method="POST" action="https://idp.example/x">
        <input type="hidden" name="SAMLRequest" value="&amp;#x2f;"></form></body>`;
    const form = parseAutoSubmitForm(html, 'https://idp.example/');
    assert.equal(form?.fields.get('SAMLRequest'), '&#x2f;');
  });

  test('resolves a relative action against the current URL', () => {
    const html = `<body onload="document.forms[0].submit()">
      <form method="POST" action="/Shibboleth.sso/SAML2/POST">
        <input type="hidden" name="SAMLResponse" value="x"></form></body>`;
    const form = parseAutoSubmitForm(html, 'https://idp.university.edu/profile/SAML2/Redirect/SSO');
    assert.equal(form?.action, 'https://idp.university.edu/Shibboleth.sso/SAML2/POST');
  });

  test('accepts WS-Federation handoffs too', () => {
    const html = `<body onload="document.forms[0].submit()">
      <form method="post" action="https://bb.edu/adfs">
        <input name="wa" value="wsignin1.0"><input name="wresult" value="<t:RequestSec"></form></body>`;
    assert.ok(parseAutoSubmitForm(html, 'https://adfs.edu/'));
  });

  test('refuses a form with no SSO payload', () => {
    // Blind-submitting an arbitrary form could post credentials or trigger an
    // unintended action, so a recognisable SSO field is mandatory.
    const html = `<body onload="document.forms[0].submit()">
      <form action="https://bb.edu/delete-account" method="POST">
        <input name="confirm" value="yes"></form></body>`;
    assert.equal(parseAutoSubmitForm(html, 'https://bb.edu/'), null);
  });

  test('refuses a form that does not submit itself', () => {
    const html = `<form action="https://bb.edu/x" method="POST">
      <input name="SAMLResponse" value="y"><button>Continue</button></form>`;
    assert.equal(parseAutoSubmitForm(html, 'https://bb.edu/'), null);
  });

  test('returns null for a page with no form', () => {
    assert.equal(parseAutoSubmitForm('<html><body>Signed out</body></html>', 'https://x/'), null);
  });
});

describe('Chromium timestamp conversion', () => {
  test('converts microseconds-since-1601 to Unix milliseconds', () => {
    // 13435163402234155 was a real cookie expiry that overflowed a JS
    // safe integer and had to be read as text.
    const ms = chromeTimeToMs(13435163402234155);
    const year = new Date(ms).getUTCFullYear();
    assert.ok(year >= 2026 && year <= 2028, `unexpected year ${year}`);
  });

  test('treats zero and non-finite input as a session cookie', () => {
    assert.equal(chromeTimeToMs(0), 0);
    assert.equal(chromeTimeToMs(Number.NaN), 0);
  });
});

describe('cookie header assembly', () => {
  const cookies = [
    { host: 'blackboard.example.edu', name: 'BbRouter', value: 'r1', path: '/', secure: true, httpOnly: true, expires: 0 },
    { host: '.blackboard.example.edu', name: 'AWSALB', value: 'a1', path: '/', secure: true, httpOnly: false, expires: 0 },
    { host: '.login.microsoftonline.com', name: 'ESTSAUTH', value: 'e1', path: '/', secure: true, httpOnly: true, expires: 0 },
  ];

  test('includes only cookies scoped to the requested host', () => {
    const header = toCookieHeader(cookies, 'blackboard.example.edu');
    assert.match(header, /BbRouter=r1/);
    assert.match(header, /AWSALB=a1/);
    assert.doesNotMatch(header, /ESTSAUTH/, 'must not leak IdP cookies to Blackboard');
  });

  test('matches parent-domain cookies', () => {
    assert.match(toCookieHeader(cookies, 'login.microsoftonline.com'), /ESTSAUTH=e1/);
  });

  test('de-duplicates repeated names', () => {
    const dup = [...cookies, { ...cookies[0]!, value: 'r2' }];
    const header = toCookieHeader(dup, 'blackboard.example.edu');
    assert.equal(header.match(/BbRouter=/g)?.length, 1);
  });
});

describe('instance host filtering', () => {
  test('rejects Blackboard infrastructure hosts', () => {
    // These set BbRouter but serve no course API, so they must never be
    // mistaken for the LMS instance during auto-discovery.
    for (const host of [
      'alt-0123456789abc.blackboard.com',
      'prod01-euc1-prod01-xythos.prod.files.blackboard.com',
      'basic-doc-viewer.eu.api.blackboard.com',
      'notif-websockets-eu-central-1.prod.notifications.api.blackboard.com',
      'developer.blackboard.com',
    ]) {
      assert.equal(isInfrastructureHost(host), true, `${host} should be rejected`);
    }
  });

  test('accepts real instance hosts', () => {
    for (const host of ['blackboard.example.edu', 'learn.university.edu', 'myuni.blackboard.com']) {
      assert.equal(isInfrastructureHost(host), false, `${host} should be accepted`);
    }
  });
});

describe('display name resolution', () => {
  test('treats an unresolved template token as unset', () => {
    // Some tenants return the literal string "GIVEN_NAME" here.
    assert.equal(
      displayName({ id: '_1_1', preferredDisplayName: 'GIVEN_NAME', givenName: 'Ada', familyName: 'Lovelace' }),
      'Ada Lovelace',
    );
  });

  test('uses a genuine preferred name when present', () => {
    assert.equal(
      displayName({ id: '_1_1', preferredDisplayName: 'Ada L.', givenName: 'Ada', familyName: 'Lovelace' }),
      'Ada L.',
    );
  });

  test('falls back through given/family then username then id', () => {
    assert.equal(displayName({ id: '_1_1', givenName: 'Ada' }), 'Ada');
    assert.equal(displayName({ id: '_1_1', userName: 'ada@x.edu' }), 'ada@x.edu');
    assert.equal(displayName({ id: '_1_1' }), '_1_1');
  });
});

describe('BbRouter xsrf extraction', () => {
  const bb = 'https://blackboard.example.edu/';

  test('tolerates a raw % in the cookie value', async () => {
    // Some tenants emit a BbRouter value that is not valid percent-encoding.
    // decodeURIComponent used to throw and abort the whole browser import.
    const jar = new CookieJar();
    await jar.setCookie(
      new Cookie({
        key: 'BbRouter',
        value: 'expires:1,id:2,xsrf:TOKEN%ZZ,signature:3',
        domain: 'blackboard.example.edu',
        path: '/',
        secure: true,
      }),
      bb,
      { ignoreError: true },
    );
    assert.equal(await extractXsrf(jar, bb), 'TOKEN%ZZ');
  });

  test('still decodes a percent-encoded BbRouter value', async () => {
    const jar = new CookieJar();
    await jar.setCookie(
      new Cookie({
        key: 'BbRouter',
        value: 'expires:1,id:2,xsrf:AB%2FCD,signature:3',
        domain: 'blackboard.example.edu',
        path: '/',
        secure: true,
      }),
      bb,
      { ignoreError: true },
    );
    assert.equal(await extractXsrf(jar, bb), 'AB/CD');
  });
});

describe('KWallet key lookup', () => {
  test('maps a Safe Storage service to its KWallet folder', () => {
    assert.equal(kwalletFolder('Brave Safe Storage'), 'Brave Keys');
    assert.equal(kwalletFolder('Chromium Safe Storage'), 'Chromium Keys');
    assert.equal(kwalletFolder('Chrome Safe Storage'), 'Chrome Keys');
  });

  test('leaves an unrecognised service name untouched', () => {
    assert.equal(kwalletFolder('Something Else'), 'Something Else');
  });
});

describe('identity provider discovery', () => {
  test('is exported and callable without any stored credentials', async () => {
    // The whole point is that this runs before anything is read from the
    // browser, so it must not require a session, and must fail soft.
    assert.equal(typeof discoverIdpHosts, 'function');
    const result = await discoverIdpHosts('https://blackboard.invalid.example', { maxHops: 1 });
    assert.ok(Array.isArray(result.hosts), 'hosts should always be an array');
    assert.ok(Array.isArray(result.hops), 'hops should always be an array');
    // An unreachable host yields nothing rather than throwing, so login can
    // fall back to the known-provider list.
    assert.equal(result.hosts.length, 0);
  });
});
