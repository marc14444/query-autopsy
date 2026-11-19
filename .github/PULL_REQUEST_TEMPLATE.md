## Summary

Describe the motivation, scope, and testing performed for this Pull Request.

## Branch & Release

- **Branch type**: `feat/` / `fix/` / `chore/` / `docs/` / `refactor/` / `ci/`
- **Triggers release on merge to `main`?** (Requires `package.json` version bump + `CHANGELOG.md` entry): Yes / No

## Related Docs / ADR

- Link any updated ADR or Tech Spec under `docs/`.

## Verification Checklist

- [ ] Branch follows `<type>/<kebab-case-slug>` naming convention.
- [ ] Followed Hexagonal boundaries in `AGENTS.md` (`src/domain/` and `src/application/` contain zero driver/UI imports).
- [ ] Added or updated Vitest unit tests under `tests/`.
- [ ] Tested manually in Extension Development Host (`F5`) if UI / DB executor changed.
- [ ] `npm run check-types` passes.
- [ ] `npm run lint` passes.
- [ ] `npm run test` passes.
- [ ] `npm run build` passes.
