---
name: feedback-visual-review
description: After running Playwright tests, always visually review the gallery — assertions passing is not enough; check both dark and light mode for UI regressions.
metadata:
  type: feedback
---

After running Playwright tests, always regenerate and visually inspect the gallery — do not rely on assertion results alone.

**Why:** Icon regressions (e.g., missing icons rendering as squares), layout breakage, and visual regressions will not cause test failures but ARE visible in screenshots. The user had to point out multiple square icons that should have been caught during visual review.

**How to apply:**
1. After every test run, regenerate the gallery: `node tests/generate-gallery.mjs`
2. Open `tests/gallery/index.html` and visually scan ALL new screenshots
3. Check for: correct icons (no squares), correct spacing, correct text, no layout breakage
4. Default review: EN + light + mobile — dark/TR/desktop only when explicitly requested
5. Delete obsolete variant screenshots when tests are removed or renamed

Links: [[feedback-test-variants]], [[feedback-test-coverage]]
