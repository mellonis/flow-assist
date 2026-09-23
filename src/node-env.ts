// Which build of React the program runs. React (and the reconciler inside
// `@flowtty/react`) picks its production or development build by
// `process.env.NODE_ENV` the moment it is first loaded, and Bun leaves the variable
// unset — so `bun src/cli.ts` and the linked command ran the development build, whose
// instrumentation makes every render slower (scrolling a long chat about twice as
// slow). The entry point calls this BEFORE anything imports React.
//
// A value that is already set wins: `NODE_ENV=test` under `bun test` (the sessions,
// the cache and `.env` loading read it), and a person who asks for `development` gets
// it. The compiled binary is decided at build time instead (`build:binary` in
// package.json defines the variable), so there this changes nothing.
//
// It takes the environment as an argument: a bundler's define rewrites
// `process.env.NODE_ENV` wherever it is written, and an assignment to it would become
// an assignment to a string.
export function defaultToProduction(env: Record<string, string | undefined>): void {
  env.NODE_ENV ??= 'production';
}
