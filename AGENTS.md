# Repository Guidelines

## Git workflow

- Always work directly on the `main` branch in this repository. Do not create feature branches.
- Do not create or open pull requests for this repository. This overrides the general instruction to create a PR for implementation work.
- Validate changes before committing them on `main`.

## Release workflow

- A release request uses `pnpm run release <version>` on clean, current `main`. It pushes the version commit and annotated tag; the tag-triggered GitHub Actions workflow validates, stages npm via OIDC, and creates a draft GitHub release.
- Do not require local npm login or credentials for this workflow, or treat a local npm authentication failure as a CI release blocker. Monitor the tag-triggered workflow instead.
- Manual npm stage approval, local publishing, and publishing the GitHub draft are separate maintainer steps. Do not attempt them or request local authentication unless the user explicitly asks for those steps.
- Report the confirmed state accurately: tag pushed, CI succeeded/failed/pending, package staged, or package published. Do not claim publication merely because the tag was pushed.
