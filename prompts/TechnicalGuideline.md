# Technical Guideline

This document should be included in all prompts desinged to generate source
codes.

## Library Selection

Always prefer popular, well maintained libraries. For maximum Deno
compatibility, prefer JSR modules over NPM packages when the API is similar or
better. Better as-in easier to reason with, takes less thinking to achieve an
implementation.

## Naming Conventions

In the same scope, names of the same class (e.g. variables, functions, classes,
interfaces, types...) should match in length for visual appeal when placed next
to each others. Their meaning should be either iterative, comparable, or
contrasting. This helps users create a mental map, strengthern their memory
after reading.

### Variables

Variable names should always be unambiguous in the shortest length possible
within it's scope.

### Functions

Generators, or function that returns another functions, should be names as
verbs. For example, a function that generates a sorting function should be
called `sorts()` as in "this sorts something", while the generated result should
be called `sorter()` when it's meant to be used as an argument for
`Array.sort(sorter)`.

Normal functions that imperatively creates side-effects should be named with
verbs in singular form, e.g. `sort()` as in "I (the developer) sort something".

## Testing

Use BDD in `jsr:@std/testing` as much as possible.

When implementing new features, a basic test with the most common designated use
cases should be defined ahead of time. Hypothesized use cases and it's
designated usage should be laid inside the test file. It acts as a critical API
guideline.

During implementation, if the API is found logically unsound, unpleasent to see,
or even impossible to implement, modify the test first before making the impl
work.

After implementation, new test cases that covers more edge cases should be
defined to ensure system stability.

Tests must be ran using the test runner MCP tool whenever possible, avoid
running them from the terminal.
