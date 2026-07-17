import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeCfEmail, extractEmails } from './emails.ts';
import { extractSocials } from './socials.ts';

describe('decodeCfEmail', () => {
  it('decodes a Cloudflare-obfuscated address', () => {
    // Encode "test@example.com" with key 0x7a to build a known-good fixture,
    // then confirm the decoder recovers it.
    const key = 0x7a;
    const email = 'test@example.com';
    let hex = key.toString(16).padStart(2, '0');
    for (const ch of email) hex += (ch.charCodeAt(0) ^ key).toString(16).padStart(2, '0');
    assert.equal(decodeCfEmail(hex), 'test@example.com');
  });

  it('rejects malformed hex rather than returning garbage', () => {
    assert.equal(decodeCfEmail('zz'), null);
    assert.equal(decodeCfEmail('7a'), null); // key only, no payload
    assert.equal(decodeCfEmail('7a6'), null); // odd length
  });
});

describe('extractEmails', () => {
  it('finds a plain-text address', () => {
    const { emails } = extractEmails('<p>Reach us at info@acme.com today</p>', 'https://acme.com');
    assert.ok(emails.includes('info@acme.com'));
  });

  it('finds a mailto link', () => {
    const { emails } = extractEmails('<a href="mailto:sales@acme.com?subject=Hi">Email</a>', 'acme.com');
    assert.ok(emails.includes('sales@acme.com'));
  });

  it('decodes Cloudflare-protected addresses in the page', () => {
    const key = 0x2b;
    const email = 'owner@acme.com';
    let hex = key.toString(16).padStart(2, '0');
    for (const ch of email) hex += (ch.charCodeAt(0) ^ key).toString(16).padStart(2, '0');
    const html = `<a href="/cdn-cgi/l/email-protection#${hex}"><span data-cfemail="${hex}">[email&#160;protected]</span></a>`;
    const { emails } = extractEmails(html, 'https://acme.com');
    assert.ok(emails.includes('owner@acme.com'), `expected owner@acme.com, got ${emails.join(',')}`);
  });

  it('ranks the domain-matching, role-based address first', () => {
    const html = '<p>joe.personal@gmail.com and info@acme.com and jane@acme.com</p>';
    const { emails } = extractEmails(html, 'https://www.acme.com');
    assert.equal(emails[0], 'info@acme.com', `got order ${emails.join(',')}`);
    assert.ok(emails.includes('joe.personal@gmail.com'), 'still keeps the gmail');
  });

  it('drops asset filenames and no-reply addresses', () => {
    const html = '<img src="logo@2x.png"> noreply@acme.com sprite@3x.jpg real@acme.com';
    const { emails } = extractEmails(html, 'acme.com');
    assert.deepEqual(emails, ['real@acme.com']);
  });
});

describe('extractSocials', () => {
  it('picks up profile links but not share widgets or bare platform pages', () => {
    const html = `
      <a href="https://facebook.com/AcmeGlass">fb</a>
      <a href="https://facebook.com/sharer/sharer.php?u=x">share</a>
      <a href="https://instagram.com/acmeglass">ig</a>
      <a href="https://twitter.com/intent/tweet">tweet</a>
      <a href="https://www.linkedin.com/company/acme-glass">li</a>
      <a href="https://youtube.com/">yt home</a>`;
    const s = extractSocials(html);
    assert.equal(s.facebook, 'https://facebook.com/AcmeGlass');
    assert.equal(s.instagram, 'https://instagram.com/acmeglass');
    assert.equal(s.linkedin, 'https://linkedin.com/company/acme-glass');
    assert.equal(s.twitter, null, 'intent/tweet is a share widget, not a profile');
    assert.equal(s.youtube, null, 'bare youtube.com is not a profile');
  });
});
