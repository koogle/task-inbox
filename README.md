# Task Inbox

A fast inbox for your open work, inside VS Code.

- **Inbox**: every open PR authored by you in the GitHub repositories of the current workspace, with CI state, detected bots, and `↩ login` when someone else replied last. The activity bar badge shows the count.
- **Local diff**: click a PR to open all its changes in one multi-file diff. The PR head is fetched into the local git object store (`git fetch <remote> pull/N/head`, no branch is created or checked out); if that fails, contents come from the GitHub API. If the PR head is what you have checked out, the right side is your real, editable working file.
- **Worktrees**: with `taskInbox.diffInWorktree` (default on), opening a PR checks its branch out into its own git worktree (`<repo>.worktrees/pr-<n>` next to the main checkout, or under `taskInbox.worktreeDir`) and the diff's right side is those real files. An existing checkout of the branch is reused. `Open Worktree in New Window`, `Sync Worktree to PR Head` (fast-forward only) and `Remove Worktree` are in the PR's context menu.
- **Drift and news**: each row shows `💬 n` for comments since you last opened the conversation, `new commits` when the PR head moved since you last opened the diff, `↓n ↑n` when the worktree is behind/ahead of the PR on GitHub, and `behind base` / `conflicts` against the base branch. The badge counts PRs needing attention and a notification appears when something new arrives. A clean worktree is fast-forwarded automatically when you open the diff.
- **Stacks and sorting**: PRs whose base branch is another of your open PRs are grouped as a stack, bottom first, each marked `↳ #parent`. The view's `...` menu switches between sorting by last updated and by number, and turns stack grouping off.
- **Talk to bots**: bots on a PR are detected from its author, commenters, reviewers, requested reviewers and head branch name. `Message Bot` posts a PR comment (prefixed with the bot's mention, if configured); `Open Conversation` shows the thread with a reply box.

## Run it

```bash
npm install
npm run compile
```

Then press `F5` in this folder to launch an Extension Development Host, and open a folder with a GitHub remote. To install it permanently: `npm run package`, then `Extensions: Install from VSIX...`.

Authentication (`taskInbox.auth`): by default the GitHub CLI login (`gh auth login`) is used when available, otherwise VS Code's built-in GitHub sign-in. The CLI login usually has access to organisation repositories that restrict OAuth apps or require SSO, which VS Code's sign-in often cannot see.

## Settings

- `taskInbox.refreshIntervalSeconds` (default 60; 0 disables polling)
- `taskInbox.repoScanDepth` (default 3): how many folder levels below each workspace folder are searched for git repositories
- `taskInbox.bots`: list of `{ name, loginPattern, branchPattern?, mention? }`. Defaults: Claude `@claude`, Devin `DevinAI`, Inspect `@{login}[bot]` (`{login}` is replaced by the bot's actual login on the PR). Adjust the patterns and mentions to match how the bots are installed in your org.
