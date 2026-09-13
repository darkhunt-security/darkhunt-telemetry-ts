<!--
Thanks for the PR! Briefly describe what changes and why.
For non-trivial changes, link the issue you discussed first.
-->

## Summary

<!-- One paragraph: what does this PR do? -->

## Why

<!-- One paragraph: what problem does it solve, or what does it enable? Link issues if any. -->

Closes #<!-- issue number, or delete this line -->

## Type of change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds capability)
- [ ] Breaking change (fix or feature that would change existing behavior)
- [ ] Documentation only
- [ ] Refactor / internal cleanup

## Checklist

- [ ] I ran `npm run format:check && npm run lint && npm run typecheck && npm test` locally and everything passes
- [ ] I added tests covering the change (regression test for bug fixes; positive + negative cases for new features)
- [ ] If I changed public API, I updated the README accordingly
- [ ] My commits are signed (`git commit -s`) per the [DCO](./CONTRIBUTING.md#commit-signing--dco)

## Test evidence

<!--
For non-trivial changes, paste relevant test output OR explain how you verified end-to-end. Examples:
- "Added test/transports.test.ts cases X and Y, all pass"
- "Manually published a tool span and verified it arrives at the backend with its tool name"
Delete this section for trivial doc/lint changes.
-->

## Risks / things reviewers should look at

<!--
Anything you want a reviewer's eyes on specifically. E.g. "the parenting change
in trace.ts affects handoffFrom[0] — please double-check the handoff tests."
-->
