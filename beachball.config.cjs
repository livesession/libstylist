// @ts-check
/**
 * Release configuration (beachball v2).
 *
 * .cjs, not .js: the root package.json is "type": "module", so a .js config is
 * parsed as ESM and `module.exports` throws.
 *
 * Versioning model: package.json versions in git are permanent `0.0.0-dev`
 * placeholders — nobody hand-bumps. Real versions live in `name@version` git
 * tags, the registry, and CHANGELOGs. beachball's jobs here are change files
 * (`pnpm change` / `beachball check`) and computing bumps + changelogs for the
 * release PR. Registry publishes happen in the workflows
 * (.github/workflows, thin callers of livesession/public-release-actions).
 *
 * `gitTags` stays off because tags are created by the release workflows in
 * the `name@1.2.3` format (beachball v2's `name_v1.2.3` format is not
 * configurable).
 *
 * @type {import('beachball/lib/types/BeachballOptions').RepoOptions}
 */
module.exports = {
  changeDir: ".change",
  // npm CLI flags beat per-package publishConfig.registry, and beachball always
  // passes --registry — so it MUST be set here, not only in packages.
  registry: "https://npm.pkg.github.com",
  access: "restricted",
  branch: "origin/master",
  gitTags: false,
  groupChanges: true,
  changehint: 'Run "pnpm change" to describe your change (bump type + changelog entry)',
  // One published package, so no lockstep groups. The package ships its docs
  // (README, SPEC, CLAUDE.md, docs/) in the tarball, so a docs change inside
  // packages/libstylist takes a change file like any other ("none" when nothing
  // published moves); only its tests never need one. beachball matches these
  // patterns with minimatch's matchBase, so a slash-less pattern matches that
  // basename at any depth — never list "README.md" here, it would exempt the
  // package's own. The repository's root files (README, CLAUDE.md, LICENSE,
  // .github) belong to no publishable package and need no pattern.
  ignorePatterns: [
    "**/*.test.ts",
    "**/test/**",
  ],
}
