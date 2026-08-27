export function selectExactDiagnosticCandidate(candidates, normalizedExpected) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const exactPathCandidates = candidates.filter(
    (candidate) => candidate?.normalized_path === normalizedExpected,
  );
  return exactPathCandidates.length === 1 ? exactPathCandidates[0] : null;
}
