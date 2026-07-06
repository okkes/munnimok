# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: signup.gallery.spec.js >> 41 step2-with-bank – account row + Get Started CTA [en-light-mobile]
- Location: tests\specs\signup.gallery.spec.js:380:3

# Error details

```
Test timeout of 30000ms exceeded.
```

# Page snapshot

```yaml
- generic [ref=e5]:
  - button "Back" [ref=e7] [cursor=pointer]:
    - img [ref=e8]
    - text: Back
  - generic [ref=e10]:
    - generic [ref=e11]: munni.
    - generic [ref=e12]: Connect your bank
    - generic [ref=e13]: Sync transactions automatically. You can always add a bank later.
    - generic [ref=e14]:
      - generic [ref=e15]: Assets
      - generic [ref=e16]: Money you own
    - generic [ref=e17]:
      - generic [ref=e18]:
        - img [ref=e20]
        - generic [ref=e23]:
          - generic [ref=e24]: Revolut
          - generic [ref=e25]: NL92 REVO 9703 7497 94
        - button [ref=e26] [cursor=pointer]:
          - img [ref=e27]
      - generic [ref=e30] [cursor=pointer]:
        - img [ref=e32]
        - generic [ref=e34]: Add asset account
        - img [ref=e35]
    - generic [ref=e37]:
      - generic [ref=e38]: Liabilities
      - generic [ref=e39]: Money you owe
    - generic [ref=e41] [cursor=pointer]:
      - img [ref=e43]
      - generic [ref=e45]: Add liability account
      - img [ref=e46]
    - button "Get started" [ref=e48] [cursor=pointer]
    - generic [ref=e49]:
      - img [ref=e50]
      - generic [ref=e53]: Bank connections are read-only (PSD2/AIS). munni never initiates payments.
```