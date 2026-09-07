import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// `globals: false` means Testing Library's automatic cleanup is not registered for us.
afterEach(() => {
  cleanup();
});

// Radix primitives (Select, Dialog) call pointer-capture and scroll APIs that
// jsdom does not implement. Without these stubs any test that opens a Select
// throws before it can assert anything.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (!window.ResizeObserver) {
  // Must be a real constructor: @floating-ui calls `new ResizeObserver(...)`.
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
