import type { IssueField, ProvisionIssue } from "../../lib/provision/errors";

export function fieldAccessibility(
  rowId: string,
  field: IssueField,
  errors: readonly ProvisionIssue[] = [],
) {
  const ids = errors.flatMap((error, index) =>
    error.field === field ? [`${rowId}-error-${index}`] : [],
  );
  return {
    "aria-invalid": ids.length > 0 || undefined,
    "aria-describedby": ids.join(" ") || undefined,
  };
}
