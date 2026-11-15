# Lessons learned

Short entries, newest last. Each is a trap that cost real debugging time — the reasoning
lives in the task's report under `.superpowers/sdd/` (scratch) or the design doc's
implementation notes.

- **A per-plugin `Object.create(services)` services view never sees an assignment
  another plugin made to its own view.** `host.services` is a view whose prototype is
  the App's shared services object; a plugin writing `host.services.foo = …` only adds
  an own property to its own view. A cross-plugin channel (like `services.postToChat`)
  must be bound on the shared object in the App's per-render services block, or it
  exists in the docs only. Covered by `src/__tests__/background-inbox.e2e.test.ts`.

- **An e2e assertion can be satisfied by the window chrome.** Asserting that the frame
  `includes('Pipelines')` passed because the title bar carried the canvas name while
  the surface never mounted (seen in the canvas plugin's e2e test, now that plugin's own
  repository); the test still failed later, but on an unrelated wait.
  Assert on the artifact's own wording (`canvas · «Pipelines»`, the surface's header),
  and failure frames then show the truth instead of hiding it.
