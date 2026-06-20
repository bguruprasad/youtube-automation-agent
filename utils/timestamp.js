// Sortable timestamp prefix for output folder names.
// Format: YYYY-MM-DD_HH-MM-SS (LOCAL time). Most-significant-first so a plain
// alphabetical/lexicographic sort of folder names == chronological creation
// order. (DD-MM-YY does NOT sort chronologically as a string, which is why the
// date-only prefix made runs hard to order.)
function folderTimestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

module.exports = { folderTimestamp };
