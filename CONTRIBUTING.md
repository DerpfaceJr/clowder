# Contributing to Clowder

Thanks for your interest. Clowder is released under the [MIT licence](LICENSE), and contributions are accepted under the same licence.

## Set up

Install Node.js 24.22.0 or newer, then from the repository root:

```powershell
npm install
```

## Check your change

Run these before you open a pull request:

```powershell
npm test
npm run check
```

The marketing site in `site/` has its own build:

```powershell
cd site
npm install
npm run build
```

The build fails if a file in the built site contains a word from the shared deny list, so keep private details out of committed files.

## Branches and pull requests

1. Fork the repository, or create a branch if you have write access.
2. Keep each pull request to one change, with a short description of what it does and why.
3. Make sure `npm test` and `npm run check` pass.
4. Open the pull request against `main`. A maintainer reviews it before it is merged.

## Conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Do not report security problems in a public issue. Follow [SECURITY.md](SECURITY.md).
