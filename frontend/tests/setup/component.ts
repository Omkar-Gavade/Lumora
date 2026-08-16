import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Unmounts between tests.
 *
 * Without it, every render stays in the document and `getByRole` starts
 * matching an element from a previous test — which fails as a confusing
 * "multiple elements" error a long way from the test that leaked.
 */
afterEach(cleanup);
