// The preload's per-test pristine start (src/__tests__/helpers/preload-hooks.ts): what one
// test leaves behind has no say in the next. Two contracts, split by whose act the
// residue is. A secret set is an artifact of exercising the host — every boot builds and
// activates one — so the start RESETS it, and this pair is what pins that. (The process's
// fetch is a test's own act, so there the start does not repair: it NAMES the leak at the
// start of the test that follows it. Keeping the mock installed past a test is what
// `helpers/fetch-seam.test.ts` guards against, and what that name is for.)
import { expect, test } from 'bun:test';
import { activeSecrets, buildSecretSet, secretStream, setActiveSecrets } from '../../assistant/secrets.ts';

// The first half of the pair: a test that ends with an active secret set behind it —
// exactly what an app's boot leaves (src/assistant/secrets.ts, `refreshSecrets`).
test('a test ends leaving an active secret set behind', () => {
  setActiveSecrets(buildSecretSet({}, { SOMETHING_TOKEN: 'aardvark-secret-value' }));
  expect(activeSecrets()).not.toBeNull();
});

// The second half: the next test starts without it. Without the reset the leftover would
// hold back a one-character chunk — `secretStream` keeps a tail that could still grow
// into a secret, and 'a' is a prefix of the value above.
test('the next test starts without it, so a one-character chunk is not held back', () => {
  expect(activeSecrets()).toBeNull();
  const stream = secretStream();
  expect(stream.push('a')).toBe('a');
  expect(stream.push('b')).toBe('b');
});
