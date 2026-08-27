function normalizeKey(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("ru-RU");
}

export function detectConfiguredRootProfile(registry, organizationHint) {
  const requested = normalizeKey(organizationHint);
  if (!requested) return null;
  return (
    (registry?.profiles ?? []).find((profile) => {
      if (profile?.allowed_root !== true) return false;
      return [profile.organization, ...(profile.aliases ?? [])]
        .map(normalizeKey)
        .includes(requested);
    }) ?? null
  );
}

export function auditConfiguredRootProfiles(registry) {
  const roots = (registry?.profiles ?? []).filter((profile) => profile?.allowed_root === true);
  const keys = new Set();
  const duplicates = [];
  for (const profile of roots) {
    const key = normalizeKey(profile.organization);
    if (keys.has(key)) duplicates.push(profile.organization);
    keys.add(key);
  }
  return { roots, duplicates };
}
