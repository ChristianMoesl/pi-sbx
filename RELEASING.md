# Releasing pi-sbx

The package is published as [`@christianmoesl/pi-sbx`](https://www.npmjs.com/package/@christianmoesl/pi-sbx).
Publishing is performed manually from a local checkout; creating a GitHub release does not publish anything automatically.

## One-time setup

Create an npm granular access token that can publish `@christianmoesl/pi-sbx`. The token can be supplied to the publishing script through `NPM_TOKEN`, so it does not need to be stored in the repository or an `.npmrc` file.

The package does not exist on npm yet, so the first release will claim the package name.

## Release

1. Update the package version without creating a tag:

   ```sh
   npm version <version> --no-git-tag-version
   ```

2. Commit and push the version change:

   ```sh
   git add package.json package-lock.json
   git commit -m "chore: release v<version>"
   git push origin main
   ```

3. Create and push an annotated tag matching the package version:

   ```sh
   git tag -a v<version> -m "v<version>"
   git push origin v<version>
   ```

4. Optionally validate the release without publishing:

   ```sh
   npm run publish:npm -- --dry-run
   ```

5. Supply the npm token and publish interactively:

   ```sh
   read -rsp "npm token: " NPM_TOKEN && echo
   NPM_TOKEN="$NPM_TOKEN" npm run publish:npm
   unset NPM_TOKEN
   ```

6. Optionally create a GitHub release for the tag:

   ```sh
   gh release create v<version> --title "v<version>" --generate-notes
   ```

The script requires a clean `main` checkout, verifies that `origin/main` and the release tag point to `HEAD`, runs the checks and package dry run, confirms npm authentication, and asks before publishing the public package.

Each npm version can only be published once. If publication fails, check whether that version exists on npm before retrying.
