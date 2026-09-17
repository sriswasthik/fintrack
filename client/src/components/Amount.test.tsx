import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Amount } from '@/components/Amount';
import { directionOf } from '@/lib/amount';

const MINUS = '−';

/** The rendered span, whatever it came out as. */
const rendered = (node: React.ReactElement) => render(node).container.firstElementChild!;

describe('the debit-positive convention', () => {
  it('reads a positive amount as money leaving', () => {
    // The whole phase rests on this being the right way round. A positive
    // amount is a purchase, not a gain, so it is the red one.
    expect(directionOf(1)).toBe('debit');
    expect(directionOf(-1)).toBe('credit');
    expect(directionOf(0)).toBeNull();
  });

  it('does not colour a difference too small to see', () => {
    expect(directionOf(0.001)).toBeNull();
    expect(directionOf(-0.004)).toBeNull();
    expect(directionOf(0.005)).toBe('debit');
  });
});

describe('Amount', () => {
  it('renders a debit in red with a leading minus', () => {
    const el = rendered(<Amount value={1234.5} />);

    expect(el).toHaveTextContent(`${MINUS}₹1,234.50`);
    expect(el).toHaveClass('text-destructive');
    expect(el).not.toHaveClass('text-chart-positive');
  });

  it('renders a credit in green with a leading plus', () => {
    const el = rendered(<Amount value={-4599} />);

    expect(el).toHaveTextContent('+₹4,599.00');
    expect(el).toHaveClass('text-chart-positive');
    expect(el).not.toHaveClass('text-destructive');
  });

  it('leaves zero uncoloured and unsigned', () => {
    // Zero went neither way. Painting it either colour would be a claim the
    // data does not make.
    const el = rendered(<Amount value={0} />);

    expect(el).toHaveTextContent('₹0.00');
    expect(el.textContent).not.toContain(MINUS);
    expect(el.textContent).not.toContain('+');
    expect(el).not.toHaveClass('text-destructive');
    expect(el).not.toHaveClass('text-chart-positive');
  });

  it('uses the magnitude when the direction is given', () => {
    // A payee's "received" is stored as a positive magnitude. Inferring from
    // the sign there would paint every credit red.
    expect(rendered(<Amount value={3900.25} direction="credit" />)).toHaveTextContent('+₹3,900.25');
    expect(rendered(<Amount value={3900.25} direction="credit" />)).toHaveClass(
      'text-chart-positive',
    );
    expect(rendered(<Amount value={-500} direction="debit" />)).toHaveTextContent(
      `${MINUS}₹500.00`,
    );
  });

  it('leaves zero alone even in a column that is always one direction', () => {
    // "Credits: +₹0.00" in green says money arrived. None did. And the same
    // number must not render two ways depending on the call site.
    const forced = rendered(<Amount value={0} direction="credit" />);
    expect(forced).toHaveTextContent('₹0.00');
    expect(forced.textContent).not.toContain('+');
    expect(forced).not.toHaveClass('text-chart-positive');
    expect(forced.textContent).toBe(rendered(<Amount value={0} />).textContent);
  });

  it('keeps the sign out of the number itself', () => {
    // formatINR would render its own hyphen for a negative amount. Two signs,
    // or a hyphen where the column wants a minus, is what passing a magnitude
    // avoids.
    const el = rendered(<Amount value={-4599} />);
    expect(el.textContent).toBe('+₹4,599.00');
    expect(el.textContent).not.toContain('-');
  });

  it('groups in the Indian style, through formatINR', () => {
    expect(rendered(<Amount value={1234567.89} />)).toHaveTextContent(`${MINUS}₹12,34,567.89`);
  });

  it('drops the paise when asked', () => {
    expect(rendered(<Amount value={1234.56} compact />)).toHaveTextContent(`${MINUS}₹1,235`);
  });

  it('always lines up in a column', () => {
    // A column of amounts that does not use tabular figures does not line up,
    // and this is the one place that can be guaranteed for every screen.
    expect(rendered(<Amount value={1} />)).toHaveClass('tabular-nums');
    expect(rendered(<Amount value={0} />)).toHaveClass('tabular-nums');
  });

  it('keeps any class the call site adds', () => {
    expect(rendered(<Amount value={1} className="text-lg" />)).toHaveClass('text-lg');
  });

  it('puts the direction in the text, not only in the colour', () => {
    // Greyscale print, a colourblind reader and a screen reader all get the
    // same answer from the sign.
    render(
      <>
        <Amount value={100} />
        <Amount value={-100} />
      </>,
    );
    expect(screen.getByText(`${MINUS}₹100.00`)).toBeInTheDocument();
    expect(screen.getByText('+₹100.00')).toBeInTheDocument();
  });
});
