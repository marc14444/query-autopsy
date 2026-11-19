---
name: query-autopsy-add-diagnostic-rule
description: >-
  Use this skill when adding a new PostgreSQL performance diagnostic rule or
  modifying existing EXPLAIN plan detection thresholds in QueryAutopsy.
---

# Add a QueryAutopsy Diagnostic Rule

Follow these steps to add a pure, unit-tested diagnostic rule without breaking Hexagonal Architecture boundaries.

## Prerequisites

- Read [TECH-SPEC-02](../../../docs/specs/TECH-SPEC-02-explain-parser-and-diagnostics.md) to verify PostgreSQL timing and cumulative buffer semantics.
- Remember: `Shared Hit Blocks`, `Shared Read Blocks`, and `Temp Written Blocks` on every `PlanNode` are **cumulative across its subtree**. Subtract immediate children's values before evaluating node-exclusive I/O or disk spills.

## Steps

1. **Register the Rule ID** in `src/domain/models/diagnostic.ts`:
   - Add the new uppercase snake-case identifier to the `DiagnosticRuleId` union.
2. **Parse Required JSON Fields** (if not already present on `PlanNode`):
   - Extend `PlanNode` in `src/domain/models/executionPlan.ts` with `| undefined` explicit optional types (required by `exactOptionalPropertyTypes`).
   - Extract the field in `src/domain/services/planParser.ts`.
3. **Implement the Pure Rule** in `src/domain/services/diagnosticEngine.ts`:
   - Write a `DiagnosticRule` function `(node, plan, config) => DiagnosticFinding | null`.
   - Guard against `plan.mode !== 'analyze'` if the rule relies on `actualRows`, `actualLoops`, or `buffers`.
   - Append the rule to `RULES`.
4. **Add Unit Tests** in `tests/domain/diagnosticEngine.test.ts` (and `tests/domain/planParser.test.ts` if new fields were parsed):
   - Test both positive detection and false-positive avoidance (e.g., parent nodes must not duplicate child alerts).
5. **Update Specification**:
   - Document the rule condition and severity thresholds in `docs/specs/TECH-SPEC-02-explain-parser-and-diagnostics.md`.
6. **Verify**:
   ```bash
   npm run check-types && npm run lint && npm run test && npm run build
   ```
