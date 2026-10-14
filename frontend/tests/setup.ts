// tests/setup.ts
//
// Loaded once before every test file (see vitest.config.ts's
// setupFiles). Extends Vitest's `expect` with jest-dom's DOM-specific
// matchers (toBeInTheDocument, toHaveTextContent, etc.) used throughout
// the component/hook tests in this directory.

import '@testing-library/jest-dom';
