export function matchTitle(filenameTitle, targetTitle) {
  if (!filenameTitle || !targetTitle) return false;

  const t1 = filenameTitle.toLowerCase().replace(/[^a-z0-9]/g, "");
  const t2 = targetTitle.toLowerCase().replace(/[^a-z0-9]/g, "");

  // Exact match after normalization
  if (t1 === t2) return true;
  
  // Contains match (if one is a substring of another)
  // This helps when Telegram filename has extra words or missing prefix/suffix
  if (t1.includes(t2) || t2.includes(t1)) return true;

  // Simple fuzzy match by word inclusion
  const words1 = filenameTitle.toLowerCase().split(/[\s\.\-\_]/).filter(w => w.length > 0);
  const words2 = targetTitle.toLowerCase().split(/[\s\.\-\_]/).filter(w => w.length > 0);
  
  let matchCount = 0;
  for (const w2 of words2) {
    if (words1.includes(w2)) matchCount++;
  }
  
  // If at least 70% of the words in the target title are in the filename
  if (matchCount > 0 && matchCount / words2.length >= 0.7) {
    return true;
  }

  return false;
}
