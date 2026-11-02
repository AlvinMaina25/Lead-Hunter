import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

// The leads list is cached at module level; start every test from empty.
// Imported lazily so that this setup file never loads the data hooks (and
// through them the API client) before a test file has registered its mocks.
afterEach(async () => {
  const { clearLeadsCache } = await import('../hooks/useData');
  clearLeadsCache();

  // The Leads table remembers its page/filters/sort across navigation;
  // don't let one test's view leak into the next.
  const { resetLeadsViewState } = await import('../lib/leadsViewState');
  resetLeadsViewState();
});
