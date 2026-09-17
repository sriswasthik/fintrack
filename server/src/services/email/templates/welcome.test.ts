import { describe, expect, it } from 'vitest';

import { renderWelcomeEmail } from './welcome';

const render = (over: Partial<Parameters<typeof renderWelcomeEmail>[0]> = {}) =>
  renderWelcomeEmail({ appUrl: 'https://app.test', ...over });

describe('the subject line', () => {
  it('is energetic without tripping a spam filter', () => {
    const { subject } = render();

    expect(subject).toBe('Welcome to FinTrack — your money, finally organised');
    // Filters weight these heavily, and an email that does not arrive is not a
    // well-designed email.
    expect(subject).not.toMatch(/[A-Z]{4,}/); // no ALL-CAPS shouting
    expect(subject).not.toMatch(/!!|\$\$\$/);
    expect(subject).not.toMatch(/\b(free|act now|urgent|winner|guarantee|click here)\b/i);
    // Long subjects get truncated in every inbox list.
    expect(subject.length).toBeLessThanOrEqual(60);
  });

  it('carries no emoji, which is where filters look hardest', () => {
    expect(render().subject).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('the HTML', () => {
  it('is a complete, self-contained document', () => {
    const { html } = render();

    expect(html).toMatch(/^<!DOCTYPE html/i);
    expect(html).toContain('</html>');
    // An external stylesheet would simply not arrive.
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
    expect(html).not.toMatch(/<script/i);
  });

  it('puts every rule inline rather than in a style block', () => {
    // Gmail strips <style> from the head, so a rule that lives there is a rule
    // that does not apply.
    const { html } = render();
    const head = html.slice(0, html.indexOf('</head>'));

    expect(head).not.toMatch(/<style/i);
    expect(html).not.toMatch(/<style[\s>]/i);
  });

  it('lays out with tables, not divs', () => {
    const { html } = render();
    const tables = html.match(/<table/g) ?? [];

    expect(tables.length).toBeGreaterThanOrEqual(5);
    tables.forEach(() => undefined);
    // Every layout table is presentational, so a screen reader does not
    // announce a grid of data that is not there.
    expect(html.match(/<table/g)!.length).toBe(html.match(/role="presentation"/g)!.length);
  });

  it('gives the gradient header a solid fallback', () => {
    // Outlook renders through Word and ignores background-image, so the
    // bgcolor underneath has to be a mid-tone rather than white.
    const { html } = render();

    expect(html).toMatch(/bgcolor="#5b21b6"/);
    expect(html).toMatch(/background-image:linear-gradient/);
  });

  it('caps its width rather than pinning it, so a phone does not scroll sideways', () => {
    const { html } = render();

    expect(html).toContain('max-width:600px');
    // …with a fixed-width wrapper for the one renderer that ignores max-width.
    expect(html).toContain('<!--[if mso]>');
  });

  it('shows the brand, a welcome and a signoff', () => {
    const { html } = render({ appUrl: 'https://app.test', name: 'Ada Lovelace' });

    expect(html).toContain('FinTrack');
    expect(html).toContain('Welcome, Ada');
    expect(html).toContain('The FinTrack team');
  });

  it('greets the account generally when there is no name', () => {
    expect(render().html).toContain('Welcome to FinTrack');
    expect(render({ name: null }).html).toContain('Welcome to FinTrack');
    expect(render({ name: '   ' }).html).toContain('Welcome to FinTrack');
  });

  it('uses icons every platform actually ships a glyph for', () => {
    // Windows has no regional-indicator glyphs, so a flag emoji renders there
    // as bare letters. Nothing here is one.
    const { html } = render();
    const icons = [...html.matchAll(/font-size:24px;line-height:28px;">([^<]+)</g)].map(
      (m) => m[1],
    );

    icons.forEach((icon) => expect(icon).not.toMatch(/\p{Regional_Indicator}/u));
  });

  it('carries four feature blocks, each with an icon', () => {
    const { html } = render();

    [
      'Built for Indian statements',
      'Categorised before you look',
      'A dashboard that answers questions',
      'Insights you did not ask for',
    ].forEach((title) => expect(html).toContain(title));
    // One icon per block, in the icon cell. Asserted as "not ASCII" rather than
    // through an emoji property: several of those do not cover every sequence
    // an icon can be, so they answer "no" for pictographs that render fine.
    const icons = [...html.matchAll(/font-size:24px;line-height:28px;">([^<]+)</g)].map(
      (m) => m[1],
    );
    expect(icons).toHaveLength(4);
    icons.forEach((icon) => {
      expect(icon.trim()).not.toBe('');
      expect(icon.codePointAt(0)).toBeGreaterThan(0x7f);
    });
  });

  it('points its call to action at the login page', () => {
    const { html } = render({ appUrl: 'https://fintrack.example.com' });

    expect(html).toContain('href="https://fintrack.example.com/login"');
    expect(html).toContain('Open FinTrack');
    // And spells the link out, for a client that will not render the button.
    expect(html.match(/https:\/\/fintrack\.example\.com\/login/g)!.length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('does not double the slash when the app url has a trailing one', () => {
    expect(render({ appUrl: 'https://fintrack.example.com/' }).html).toContain(
      'https://fintrack.example.com/login',
    );
    expect(render({ appUrl: 'https://fintrack.example.com//' }).html).not.toContain('com//login');
  });

  it('escapes a name rather than rendering it as markup', () => {
    // The name arrives from a registration form or a Google profile. An email
    // client is a HTML renderer like any other.
    const { html } = render({ appUrl: 'https://app.test', name: '<img src=x onerror=alert(1)>' });

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('hides the preheader from the body while leaving it for the inbox list', () => {
    const { html } = render();

    expect(html).toContain('Import a statement, and FinTrack sorts the rest');
    expect(html).toMatch(/display:none;max-height:0;overflow:hidden;mso-hide:all/);
  });

  it('says why the message was sent', () => {
    // A welcome email that does not explain itself reads like a list purchase.
    expect(render().html).toContain('an account was just created with this address');
  });
});

describe('the plain-text version', () => {
  it('is the same message, not a stub', () => {
    const { text } = render({ appUrl: 'https://fintrack.example.com', name: 'Ada Lovelace' });

    expect(text).toContain('Welcome, Ada');
    expect(text).toContain('https://fintrack.example.com/login');
    expect(text).toContain('The FinTrack team');
    [
      'Built for Indian statements',
      'Categorised before you look',
      'A dashboard that answers questions',
      'Insights you did not ask for',
    ].forEach((title) => expect(text).toContain(title));
  });

  it('carries no markup at all', () => {
    const { text } = render();

    expect(text).not.toMatch(/<[a-z/!]/i);
    expect(text).not.toContain('&amp;');
    expect(text).not.toContain('&#39;');
  });

  it('wraps to a width a text client will not mangle', () => {
    const { text } = render({ appUrl: 'https://fintrack.example.com', name: 'Ada' });

    text
      .split('\n')
      // A bare URL is allowed to run long: breaking one makes it unclickable.
      .filter((line) => !line.includes('://'))
      .forEach((line) => expect(line.length).toBeLessThanOrEqual(78));
  });

  it('is long enough to read as a real message', () => {
    // A one-line text part alongside rich HTML is itself a spam signal.
    expect(render().text.length).toBeGreaterThan(400);
  });
});
