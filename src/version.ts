// The host's version. It must equal the `version` in package.json — a test holds
// the two together — and CHANGELOG.md says what each version brought.
export function hostVersion(): string {
  return '0.1.0';
}
