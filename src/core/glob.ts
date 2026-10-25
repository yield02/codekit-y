// Minimal glob matcher for include/exclude patterns: `**`, `*`, `?`.
// Patterns without a slash match against the basename (gitignore-like).

const cache = new Map<string, RegExp>();

function toRegExp(pattern: string): RegExp {
  let cached = cache.get(pattern);
  if (cached) return cached;
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        const slashAfter = pattern[i + 2] === "/";
        re += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  cached = new RegExp(`^${re}$`);
  cache.set(pattern, cached);
  return cached;
}

export function matchesGlob(path: string, pattern: string): boolean {
  const p = path.replace(/\\/g, "/");
  if (!pattern.includes("/")) {
    const base = p.slice(p.lastIndexOf("/") + 1);
    return toRegExp(pattern).test(base);
  }
  const normalized = pattern.replace(/^\.?\//, "").replace(/\/$/, "/**");
  return toRegExp(normalized).test(p);
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pat) => matchesGlob(path, pat));
}

/** Included when it matches an include pattern (or includes is empty) and no exclude pattern. */
export function isIncluded(path: string, include: readonly string[], exclude: readonly string[]): boolean {
  if (include.length > 0 && !matchesAny(path, include)) return false;
  return !matchesAny(path, exclude);
}
