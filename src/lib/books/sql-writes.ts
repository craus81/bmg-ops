// Read by the books' SQL tests (migrations/README.md "Adding a migration").

/**
 * The DELETE and UPDATE statements in a function body that have no WHERE
 * of their own. Supabase's API connections load the safeupdate extension,
 * which fails those even inside a function called through rpc; PGlite
 * doesn't have it, so the bodies are read for them instead.
 */
export function unguardedWrites(body: string): string[] {
  // Comments and quoted text out first, keeping the code's shape.
  let code = '';
  for (let i = 0; i < body.length;) {
    if (body.startsWith('--', i)) {
      const end = body.indexOf('\n', i);
      i = end < 0 ? body.length : end;
    } else if (body.startsWith('/*', i)) {
      const end = body.indexOf('*/', i + 2);
      i = end < 0 ? body.length : end + 2;
    } else if (body[i] === "'") {
      let j = i + 1;
      while (j < body.length && !(body[j] === "'" && body[j + 1] !== "'")) j += body[j] === "'" ? 2 : 1;
      i = j + 1;
      code += "''";
    } else {
      code += body[i++];
    }
  }
  const found: string[] = [];
  const writes = /\b(?:DELETE\s+FROM\s+[\w."]+|UPDATE\s+(?:ONLY\s+)?[\w."]+(?:\s+(?:AS\s+)?(?!SET\b)\w+)?\s+SET)\b/gi;
  for (const m of code.matchAll(writes)) {
    // ON CONFLICT ... DO UPDATE belongs to an INSERT, which safeupdate leaves alone.
    if (/\bDO\s*$/i.test(code.slice(0, m.index))) continue;
    // The statement runs to its ';', or to the ')' that closes it inside a WITH.
    let depth = 0;
    let own = '';
    for (let i = m.index! + m[0].length; i < code.length; i++) {
      const ch = code[i];
      if (ch === '(') depth++;
      else if (ch === ')' && --depth < 0) break;
      else if (ch === ';' && depth === 0) break;
      else if (depth === 0) own += ch;
    }
    if (!/\bWHERE\b/i.test(own)) found.push(m[0].replace(/\s+/g, ' '));
  }
  return found;
}
