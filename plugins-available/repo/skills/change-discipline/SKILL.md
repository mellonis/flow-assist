---
name: change-discipline
description: Load before changing code, writing or refining a ticket, or preparing a merge request — rules for shared code, scope, open questions, tests and a review before publishing.
---

# Change discipline

Rules for a code change from the ticket to the merge request. They keep a change to what
was asked, make its reach visible, and leave the decisions that are the person's to the
person.

## 1. Shared code: find every consumer first

Before you change a shared module, hook, component or utility, find every place that uses
it (search the repository for its name and its import path, not only the file you came
from). Read each consumer far enough to know what your change does to it. The merge
request lists every consumer the change reaches and what happens to each.

## 2. Keep the old reach; widen it only on the person's word

Moving or adding behaviour into shared code keeps the reach it had: if the behaviour
belonged to one consumer, it still belongs to that one consumer after the change. Widening
it to every consumer of the shared code is a decision the person makes, explicitly — never
a side effect of where the call was convenient to put.

Prefer giving the shared code a parameter or a callback and passing the specific behaviour
from the specific consumer, over putting the behaviour inside the shared code.

## 3. A ticket describes the problem, not the place in the code

A ticket says what is wrong or missing and how to tell it is done (acceptance criteria). It
does not name the file or function to change: that is decided by the analysis, after the
code has been read. When you write a ticket before the analysis, leave the implementation
open; when a ticket already names a place, treat it as a hint and check it.

## 4. An open question stops the change

When the analysis raises a question the ticket does not answer (does this apply to every
case or only to one? should the old behaviour stay?), do one of these before writing code:

- ask the person, and wait for the answer; or
- choose the conservative option — the existing behaviour, the narrowest reach — and say
  plainly in the merge request that you chose it and why.

Never implement the widest option and leave the question in the merge request's
description: the reviewer then has to find it, and the wider behaviour is already built.

## 5. Every "must not" gets its own test

Each negative requirement ("does not show", "does not affect X", "only for Y") gets a test
of its own that fails if the requirement breaks. When the behaviour depends on which
consumer uses shared code, test it at the consumer: a test of the shared code alone cannot
show that the other consumers are unaffected.

## 6. Nothing outside the task

- Changes a linter or formatter makes on its own to files the task does not touch are not
  part of the change: revert them, or name them in the merge request — never commit them
  silently.
- Do not alter the environment to make something work — linking other dependencies in,
  editing shared configuration, disabling a check — without the person deciding it. If the
  environment blocks you, say what blocks you.
- Leave the working copy with only the task's changes in it.

## 7. Review against the ticket before publishing

Before a push or a merge request, check the change against the ticket and each of its
acceptance criteria — best by a separate reviewer or agent that reads the ticket and the
diff fresh, without your reasoning. Fix what it finds before you push, not after.
