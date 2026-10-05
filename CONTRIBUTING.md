# Contributing

Thanks for helping improve this Cloudflare Workers reference.

## How To Contribute

1. Fork the repository.
2. Create a focused branch from `main`.
3. Make and test your changes.
4. Open a pull request describing the behavior and verification performed.

## Development Setup

```sh
git clone https://github.com/<your-user>/cloudflare-worker-version-routing.git
cd cloudflare-worker-version-routing
npm install
npm run check
```

Use `npm run dev:target` or `npm run dev:caller` for local Worker development. Public Preview/Version URLs and cross-Worker edge routing require a deployed lab; see the bootstrap instructions in the README before creating Cloudflare resources. Keep credential-free tests independent of the ignored cloud manifest by using the sanitized Preview fixture and injected lifecycle lookups.

## Code Style

- Follow the existing TypeScript and JSON formatting in the repository.
- Use tabs in TypeScript and JavaScript files, as configured by `.editorconfig` and `.prettierrc`.
- Keep Worker configuration in JSONC and regenerate binding types with `npm run cf-typegen` after changing bindings or variables.
- Add comments for non-obvious routing decisions, not for self-explanatory statements.

## Commit Messages

Use short, imperative commit subjects that describe the user-visible change, such as `Document alias routing behavior`.

## Pull Request Process

- Keep each pull request scoped to one concern.
- Include tests for routing or validation changes.
- Update the README when behavior, setup, or platform constraints change.
- Run `npm run check` and include the result in the pull request.
- Never commit Cloudflare API tokens, account IDs, private hostnames, or generated IDs from a deployment you do not intend to publish.

## Bug Reports

Use the [bug report template](../../issues/new?template=bug_report.md). Include the caller response, Wrangler version, relevant Worker configuration with secrets removed, and clear reproduction steps.

## Feature Requests

Use the [feature request template](../../issues/new?template=feature_request.md) and explain which routing or deployment problem the proposal addresses.

## Code Of Conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
