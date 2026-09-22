/**
 * Best-effort JSON extraction from an LLM's raw text response — handles a
 * clean JSON object, one wrapped in a ```json fenced block, or one embedded in
 * a sentence despite the prompt asking for JSON only. Shared by every Nemotron
 * response parser (aiResponseParser, and any future one) so "malformed AI
 * output" is handled the same way everywhere. Mirrors hermesResultParser's
 * extractJson (same problem, same fix — not duplicated logic, just reused
 * across two independent AI integrations that don't share a module boundary).
 */
function extractJson(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : rawText).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    // Fall through to a best-effort brace-matched slice.
  }
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

module.exports = { extractJson };
