// Which build of React the program runs. React (and the reconciler inside
// `@flowtty/react`) picks its production or development build by
// `process.env.NODE_ENV` the moment it is first loaded, and Bun leaves the variable
// unset — so `bun src/cli.ts` and the linked command ran the development build, whose
// instrumentation makes every render slower (scrolling a long chat about twice as
// slow). The entry point loads its modules through this BEFORE anything imports React.
//
// The variable is set only while those modules load. Every program the assistant
// starts inherits the process environment, and `NODE_ENV=production` makes `npm
// install` skip devDependencies, so the person's own state is put back once the load
// ends: an unset variable is unset again, and a value the person set (`test` under
// `bun test`, `development`) is never touched. This holds for a source run and for the
// compiled binary alike — `build:binary` defines the literal text `process.env.NODE_ENV`
// for the bundler, but the environment passed here is a plain object, so the binary
// sets the variable at run time too.
//
// It takes the environment as an argument: a bundler's define rewrites
// `process.env.NODE_ENV` wherever it is written, and an assignment to it would become
// an assignment to a string.
export async function withProductionDefault<T>(env: Record<string, string | undefined>, load: () => Promise<T>): Promise<T> {
  const wasUnset = env.NODE_ENV === undefined;
  if (wasUnset) env.NODE_ENV = 'production';
  try {
    return await load();
  } finally {
    if (wasUnset) delete env.NODE_ENV;
  }
}
